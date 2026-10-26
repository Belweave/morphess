import { relative, resolve, sep, isAbsolute, join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';
import { truncateUtf8, type WorkspaceExecutionEnv } from '../policy/workspace.js';

const EXCLUDED = new Set(['.git', '.morphess', '.morphess-tmp', 'node_modules', '.DS_Store']);
const MAX_FILES = 10_000;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
interface Listing { paths: string[]; truncated: boolean; backend: 'ripgrep' | 'environment'; }

function environment(api: ToolExecutionApi): ExecutionEnv {
  if (!api.env) throw new Error('Workspace tools require an execution environment');
  return api.env;
}
function scopedPath(env: ExecutionEnv, input: string): string {
  if (input.includes('\0')) throw new Error('Invalid workspace path');
  const absolute = resolve(env.cwd, input);
  const rest = relative(env.cwd, absolute);
  if (isAbsolute(rest) || rest === '..' || rest.startsWith(`..${sep}`)) throw new Error('Path is outside the workspace');
  return absolute;
}
function result(text: string, maxBytes: number, details: Record<string, string | number | boolean> = {}): ToolExecutionResult {
  const truncated = Buffer.byteLength(text) > maxBytes;
  const marker = '\n[Output truncated; narrow the path or query.]';
  const output = truncated ? truncateUtf8(text, Math.max(0, maxBytes - Buffer.byteLength(marker))) + truncateUtf8(marker, Math.min(maxBytes, Buffer.byteLength(marker))) : text;
  return { output: [{ type: 'text', text: output }], details: { ...details, outputTruncated: truncated } };
}
function hasReadonlyCommands(env: ExecutionEnv): env is WorkspaceExecutionEnv {
  return 'readOnlyCommand' in env && typeof env.readOnlyCommand === 'function';
}

/** Bounded portable directory walk. Links are listed, never traversed. */
export async function listWorkspaceFiles(env: ExecutionEnv, input: string, context: Context, maxBytes = 512 * 1024): Promise<Listing> {
  const directory = scopedPath(env, input);
  // Pi-compatible remote environments need no host process access. The local
  // guarded environment offers a fixed argv rg capability, with a portable walk
  // when ripgrep is unavailable.
  if (hasReadonlyCommands(env)) {
    let output = '';
    let bytes = 0;
    const command = await env.readOnlyCommand({ kind: 'list-files', path: directory }, {
      timeout: 10,
      onOutput(chunk) { const kept = truncateUtf8(chunk, maxBytes - bytes); output += kept; bytes += Buffer.byteLength(kept); },
    }, context);
    if (command.ok && command.value.exitCode === 0) {
      const lines = output.split('\0');
      const complete = output.endsWith('\0');
      if (!complete) lines.pop();
      const paths = lines.filter(Boolean).map((path) => relative(directory, path)).filter((path) => !path.split(sep).some((part) => EXCLUDED.has(part)));
      return { paths: paths.slice(0, MAX_FILES), truncated: command.value.outputTruncated || !complete || bytes >= maxBytes || paths.length > MAX_FILES, backend: 'ripgrep' };
    }
  }
  const paths: string[] = [];
  let bytes = 0;
  let truncated = false;
  let visitedEntries = 0;
  const deadline = Date.now() + 10_000;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 32 || paths.length >= MAX_FILES || bytes >= maxBytes || Date.now() > deadline) { truncated = true; return; }
    if (context.abortSignal?.aborted) throw new Error('Operation aborted');
    const reader = getOrThrow(await env.openDirReader(path, context));
    try {
      let done = false;
      while (!done && !truncated) {
        const page = getOrThrow(await reader.next(128, context));
        done = page.done;
        for (const entry of page.entries) {
          if (++visitedEntries > MAX_FILES * 2 || Date.now() > deadline) { truncated = true; break; }
          if (EXCLUDED.has(entry.name)) continue;
          if (entry.kind === 'directory') await walk(join(path, entry.name), depth + 1);
          else {
            const name = relative(directory, join(path, entry.name));
            bytes += Buffer.byteLength(name) + 1;
            if (bytes > maxBytes || paths.length >= MAX_FILES) { truncated = true; break; }
            paths.push(name);
          }
          if (truncated) break;
        }
      }
    } finally { await reader.close(context); }
  };
  await walk(directory, 0);
  paths.sort();
  return { paths, truncated, backend: 'environment' };
}

/** Read-only capabilities; all execution and file access goes through Pi's env. */
export function createWorkspaceTools(options: { workspace: string; maxOutputBytes: number }): Extension {
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 128) throw new Error('maxOutputBytes must be at least 128');
  const limits = { maxBytes: options.maxOutputBytes, maxLines: 2000, retain: 'head' as const };
  return defineExtension({
    name: 'morphess-workspace',
    tools: [
      defineTool({
        name: 'list_files',
        description: 'List workspace files using ripgrep when available, with a bounded portable fallback. Skips .git, .morphess and node_modules. Symbolic links are never traversed.',
        parameters: Type.Object({ path: Type.Optional(Type.String({ description: 'Workspace relative directory; defaults to .' })) }),
        replay: 'safe',
        outputLimits: limits,
        async execute(args, api, context) {
          const listing = await listWorkspaceFiles(environment(api), args.path ?? '.', context, options.maxOutputBytes);
          return result(listing.paths.join('\n') + (listing.truncated ? '\n[Listing truncated; narrow the path.]' : ''), options.maxOutputBytes, { backend: listing.backend, listingTruncated: listing.truncated });
        },
      }),
      defineTool({
        name: 'search',
        description: 'Search literal text in workspace files. Case sensitive by default. Bounded scan skips binary/large files, dependencies and session data; narrow path for exhaustive results.',
        parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 4096 }), path: Type.Optional(Type.String()), caseSensitive: Type.Optional(Type.Boolean()), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
        replay: 'safe',
        outputLimits: limits,
        async execute(args, api, context) {
          const env = environment(api);
          const directory = scopedPath(env, args.path ?? '.');
          const info = getOrThrow(await env.fileInfo(directory, context));
          const listing = info.kind === 'file' ? { paths: [''], truncated: false, backend: 'environment' as const } : await listWorkspaceFiles(env, args.path ?? '.', context);
          const query = args.caseSensitive === false ? args.query.toLocaleLowerCase('en-US') : args.query;
          if (!query) throw new Error('Search query must not be empty');
          const matches: string[] = [];
          const maxResults = args.maxResults ?? 100;
          let scannedBytes = 0;
          let scannedFiles = 0;
          let skippedFiles = 0;
          let truncated = listing.truncated;
          let outputBytes = 0;
          const deadline = Date.now() + 10_000;
          for (const path of listing.paths) {
            if (context.abortSignal?.aborted) throw new Error('Operation aborted');
            if (Date.now() > deadline || scannedBytes >= MAX_SCAN_BYTES || matches.length >= maxResults || outputBytes >= options.maxOutputBytes) { truncated = true; break; }
            const file = path ? join(directory, path) : directory;
            const opened = await env.openBinaryReader(file, { noFollow: true }, context);
            if (!opened.ok) { skippedFiles++; continue; }
            try {
              const metadata = getOrThrow(await opened.value.info(context));
              if (metadata.size > MAX_FILE_BYTES || metadata.size > MAX_SCAN_BYTES - scannedBytes) { skippedFiles++; continue; }
              const data = getOrThrow(await opened.value.read(0, Math.min(metadata.size, MAX_FILE_BYTES), context));
              scannedBytes += data.byteLength;
              if (data.includes(0)) { skippedFiles++; continue; }
              scannedFiles++;
              const content = new TextDecoder().decode(data);
              let start = 0;
              for (let index = 0; start <= content.length; index++) {
                if (index % 128 === 0 && (context.abortSignal?.aborted || Date.now() > deadline)) { truncated = true; break; }
                const newline = content.indexOf('\n', start);
                const end = newline < 0 ? content.length : newline;
                const line = content.slice(start, end);
                start = newline < 0 ? content.length + 1 : newline + 1;
                const haystack = args.caseSensitive === false ? line.toLocaleLowerCase('en-US') : line;
                const position = haystack.indexOf(query);
                if (position < 0) continue;
                const display = `${relative(env.cwd, file)}:${index + 1}:${truncateUtf8(line.slice(Math.max(0, position - 120), Math.max(0, position - 120) + 600), 600)}`;
                matches.push(display);
                outputBytes += Buffer.byteLength(display) + 1;
                if (matches.length >= maxResults || outputBytes >= options.maxOutputBytes) { truncated = true; break; }
              }
            } finally { await opened.value.close(context); }
          }
          if (skippedFiles) truncated = true;
          return result((matches.length ? matches.join('\n') : 'No matches in scanned files.') + (truncated ? '\n[Search incomplete: limits or skipped files; narrow the path.]' : ''), options.maxOutputBytes, { scannedFiles, scannedBytes, skippedFiles, incomplete: truncated });
        },
      }),
      defineTool({
        name: 'read_bytes',
        description: 'Read a bounded byte range from a regular workspace file without scanning preceding lines. Useful for very large files; UTF-8 ranges may begin or end within a character. Use base64 for binary data.',
        parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 })), encoding: Type.Optional(Type.Union([Type.Literal('utf8'), Type.Literal('base64')])) }),
        replay: 'safe',
        outputLimits: limits,
        async execute(args, api, context) {
          const env = environment(api);
          const path = scopedPath(env, args.path);
          const reader = getOrThrow(await env.openBinaryReader(path, undefined, context));
          try {
            const metadata = getOrThrow(await reader.info(context));
            const offset = args.offset ?? 0;
            const encoding = args.encoding ?? 'utf8';
            const available = Math.max(1, options.maxOutputBytes - 96);
            const budget = encoding === 'base64' ? Math.max(1, Math.floor(available / 4) * 3) : available;
            const bytes = getOrThrow(await reader.read(offset, Math.min(args.length ?? 16 * 1024, budget), context));
            if (encoding === 'utf8' && bytes.includes(0)) throw new Error('Range contains binary data; use encoding base64');
            const value = Buffer.from(bytes).toString(encoding);
            const nextOffset = offset + bytes.length;
            return result(`Bytes ${offset}-${nextOffset} of ${metadata.size}; next offset ${nextOffset}.\n${value}`, options.maxOutputBytes, { offset, nextOffset, totalBytes: metadata.size, encoding });
          } finally { await reader.close(context); }
        },
      }),
      ...(['git_status', 'git_diff'] as const).map((name) => defineTool({
        name,
        description: name === 'git_status' ? 'Read workspace git status using fixed argv, with optional literal workspace path.' : 'Read unstaged git diff using fixed argv; external diff drivers and text conversions are disabled.',
        parameters: Type.Object({ path: Type.Optional(Type.String()) }),
        replay: 'safe',
        outputLimits: limits,
        async execute(args, api, context) {
          const env = environment(api);
          if (!hasReadonlyCommands(env)) throw new Error('Environment does not provide the guarded git capability');
          let text = '';
          let bytes = 0;
          const command = getOrThrow(await env.readOnlyCommand({ kind: name === 'git_status' ? 'git-status' : 'git-diff', ...(args.path === undefined ? {} : { path: scopedPath(env, args.path) }) }, {
            timeout: 10,
            onOutput(chunk) { const kept = truncateUtf8(chunk, options.maxOutputBytes - bytes); text += kept; bytes += Buffer.byteLength(kept); },
          }, context));
          if (command.exitCode !== 0) return { ...result(text || `git exited ${command.exitCode}`, options.maxOutputBytes), isError: true };
          if (command.outputTruncated || bytes >= options.maxOutputBytes) text += '\n[Output truncated; narrow the path.]';
          return result(text || '(clean)', options.maxOutputBytes, { exitCode: command.exitCode });
        },
      })),
    ],
  });
}
