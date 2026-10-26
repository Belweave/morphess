import { randomUUID } from 'node:crypto';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { err, ExecutionError, FileError, ok, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from '@earendil-works/pi-durable/env';

export type WorkspaceMode = 'read-only' | 'workspace-write' | 'trusted';
export interface WorkspaceEnvironmentOptions {
  workspace: string;
  mode: WorkspaceMode;
  shellTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Additional harness-owned state paths, denied for reads and writes. */
  protectedPaths?: readonly string[];
}
export type ReadOnlyCommand = { kind: 'git-status' | 'git-diff'; path?: string } | { kind: 'list-files'; path: string };
export interface BoundedShellExecResult extends ShellExecResult { outputTruncated: boolean; }
export interface WorkspaceExecutionEnv extends ExecutionEnv {
  /** Fixed argv capabilities, separate from arbitrary shell permission. */
  readOnlyCommand(request: ReadOnlyCommand, options: ShellExecOptions, context: Context): Promise<Result<BoundedShellExecResult, ExecutionError>>;
}

function inside(root: string, candidate: string): boolean {
  const rest = relative(root, candidate);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
/** Return a UTF-8 prefix without splitting a code point. */
export function truncateUtf8(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  const data = Buffer.from(text);
  if (data.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}

/**
 * Pi's local environment with a workspace capability boundary. This is defense in
 * depth, not an OS sandbox: a concurrently hostile process can race path checks.
 * Trusted shell commands run on the host with the host's privileges.
 */
export async function createWorkspaceEnvironment(options: WorkspaceEnvironmentOptions): Promise<WorkspaceExecutionEnv> {
  if (!['read-only', 'workspace-write', 'trusted'].includes(options.mode)) throw new Error('Invalid workspace mode');
  const mode = options.mode;
  const root = await realpath(resolve(options.workspace));
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace must be a directory');
  const timeoutMs = positiveInteger(options.shellTimeoutMs ?? 120_000, 'shellTimeoutMs');
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 64 * 1024, 'maxOutputBytes');
  const base = new NodeExecutionEnv({ cwd: root });
  const canonicalizeMissing = async (path: string): Promise<string> => {
    try { return await realpath(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
      return join(await canonicalizeMissing(dirname(path)), basename(path));
    }
  };
  const protectedInputs = [join(root, '.morphess'), ...(options.protectedPaths ?? []).map((path) => resolve(root, path))];
  const protectedRoots = [...new Set([...protectedInputs, ...await Promise.all(protectedInputs.map(canonicalizeMissing))])];
  const hasCustomProtectedPaths = protectedRoots.some((path) => inside(root, path) && !inside(join(root, '.morphess'), path));
  const gitRoot = join(root, '.git');
  const protectedSubtreeMutation = (path: string): void => {
    if ([...protectedRoots, gitRoot].some((protectedRoot) => inside(path, protectedRoot))) throw new FileError('permission_denied', 'Cannot mutate a directory containing protected harness or Git state', path);
  };
  const checkProtected = (path: string, write: boolean): void => {
    if (protectedRoots.some((protectedRoot) => inside(protectedRoot, path))) throw new FileError('permission_denied', 'Harness state path is protected', path);
    if (write && inside(gitRoot, path)) throw new FileError('permission_denied', 'Git metadata mutation is protected; use an explicitly trusted shell for repository administration', path);
  };
  // npm scripts prepend workspace/node_modules/.bin to PATH. Never execute a
  // repository-controlled binary as a supposedly read-only capability.
  const findHostExecutable = async (candidates: readonly string[]): Promise<string | undefined> => {
    for (const candidate of candidates) {
      try {
        const canonical = await realpath(candidate);
        if (inside(root, canonical)) continue;
        await access(canonical, constants.X_OK);
        return canonical;
      } catch { /* Try the next known host installation. */ }
    }
    return undefined;
  };
  const [rgExecutable, gitExecutable] = await Promise.all([
    findHostExecutable(['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg', '/bin/rg']),
    findHostExecutable(['/usr/bin/git', '/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']),
  ]);
  const writeMethods = new Set(['writeFile', 'appendFile', 'truncateFile', 'flushFile', 'renameFile', 'createDir', 'remove']);
  const pathMethods = new Set(['absolutePath', 'canonicalPath', 'readTextFile', 'readTextLines', 'openTextLineReader', 'readBinaryFile', 'openBinaryReader', 'writeFile', 'appendFile', 'truncateFile', 'flushFile', 'renameFile', 'fileInfo', 'listDir', 'openDirReader', 'exists', 'createDir', 'remove']);
  const denied = (path: string, message = 'Path is outside the workspace') => new FileError('permission_denied', message, path);
  const guard = async (input: unknown, write = false): Promise<string> => {
    if (typeof input !== 'string' || input.includes('\0')) throw new FileError('invalid', 'Invalid workspace path');
    const absolute = resolve(root, input);
    if (!inside(root, absolute)) throw denied(input);
    checkProtected(absolute, write);
    // Resolve each existing ancestor; missing children can be created only below a
    // contained ancestor. ENOTDIR, ELOOP and permission errors fail closed.
    let ancestor = absolute;
    for (;;) {
      try {
        const canonical = await realpath(ancestor);
        if (!inside(root, canonical)) throw denied(input, 'Symbolic link escapes the workspace');
        checkProtected(canonical, write);
        return absolute;
      } catch (error) {
        if (error instanceof FileError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A dangling symlink must not be treated as a missing path: its eventual
        // target may be outside the workspace.
        try {
          if ((await lstat(ancestor)).isSymbolicLink()) throw denied(input, 'Dangling symbolic links are not allowed');
        } catch (statError) {
          if (statError instanceof FileError || (statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) throw denied(input);
        ancestor = parent;
      }
    }
  };
  const asFileError = (error: unknown, path?: string) => error instanceof FileError ? error : new FileError('unknown', error instanceof Error ? error.message : String(error), path);
  const boundedExec = async (command: string | readonly string[], execOptions: ShellExecOptions | undefined, context: Context, readonly = false): Promise<Result<BoundedShellExecResult, ExecutionError>> => {
    try {
      const cwd = await guard(execOptions?.cwd ?? root);
      const requested = execOptions?.timeout;
      if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) return err(new ExecutionError('timeout', 'Timeout must be positive and finite'));
      let emitted = 0;
      let outputTruncated = false;
      const marker = '\n[Output truncated by workspace policy.]';
      const outputBudget = readonly ? maxOutputBytes : Math.max(0, maxOutputBytes - Buffer.byteLength(marker));
      const result = await base.exec(command, {
        ...execOptions,
        cwd,
        timeout: Math.min(timeoutMs / 1000, requested ?? timeoutMs / 1000),
        // Disable Pi's unbounded output spill: local spill files live outside this
        // workspace. Pi still durably retains the bounded tool output.
        spill: undefined,
        window: undefined,
        inheritEnv: readonly ? false : execOptions?.inheritEnv,
        onOutput(text, ctx, info) {
          const kept = truncateUtf8(text, outputBudget - emitted);
          if (Buffer.byteLength(kept) < Buffer.byteLength(text)) outputTruncated = true;
          emitted += Buffer.byteLength(kept);
          if (kept) execOptions?.onOutput?.(kept, ctx, { stream: info.stream });
        },
      }, context);
      if (outputTruncated && !readonly) execOptions?.onOutput?.(truncateUtf8(marker, maxOutputBytes - emitted), context, { stream: 'stdout' });
      return result.ok ? ok({ ...result.value, outputTruncated }) : result;
    } catch (error) {
      return err(new ExecutionError('spawn_error', error instanceof Error ? error.message : String(error)));
    }
  };
  const env = new Proxy(base, {
    has(target, property) { return property === 'readOnlyCommand' || Reflect.has(target, property); },
    get(target, property) {
      if (property === 'cwd') return root;
      if (property === 'readOnlyCommand') return async (request: ReadOnlyCommand, execOptions: ShellExecOptions, context: Context) => {
        try {
          if (request.kind === 'list-files') {
            if (hasCustomProtectedPaths) return err(new ExecutionError('shell_unavailable', 'Custom protected paths require the portable environment walk'));
            if (!rgExecutable) return err(new ExecutionError('shell_unavailable', 'No trusted host ripgrep installation; use the portable environment walk'));
            const directory = await guard(request.path);
            return boundedExec([rgExecutable, '--files', '--null', '--hidden', '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!.morphess/**', '--glob', '!.morphess-tmp/**', '--', directory], {
              ...execOptions, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
            }, context, true);
          }
          if (request.kind !== 'git-status' && request.kind !== 'git-diff') throw new Error('Unsupported read-only capability');
          // Disallow linked worktrees and parent repositories: those put git's
          // metadata outside this environment's file capability.
          const metadata = await guard(join(root, '.git'));
          if (!(await lstat(metadata)).isDirectory()) throw new Error('Git metadata must be a directory inside the workspace');
          if (!gitExecutable) return err(new ExecutionError('shell_unavailable', 'No trusted host Git installation'));
          const path = request.path === undefined ? undefined : await guard(request.path);
          const args = [gitExecutable, '--no-pager', '--git-dir=' + metadata, '--work-tree=' + root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'safe.directory=' + root];
          if (request.kind === 'git-status') args.push('status', '--short', '--untracked-files=normal', '--ignore-submodules=all');
          else args.push('diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all');
          args.push('--', `:(literal)${path ? relative(root, path) || '.' : '.'}`);
          // Pathspec magic is constructed by the host, never supplied by the
          // model. Excluded directories protect even accidentally tracked state
          // from leaking through an unscoped diff.
          for (const protectedRoot of [...protectedRoots, join(root, '.morphess-tmp')]) {
            if (inside(root, protectedRoot)) args.push(`:(exclude,literal)${relative(root, protectedRoot) || '.'}`);
          }
          return boundedExec(args, {
            ...execOptions,
            cwd: root,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
          }, context, true);
        } catch (error) {
          return err(new ExecutionError('spawn_error', error instanceof Error ? error.message : String(error)));
        }
      };
      if (property === 'exec') return (command: string | readonly string[], execOptions: ShellExecOptions | undefined, context: Context) => mode === 'trusted'
        ? boundedExec(command, execOptions, context)
        : Promise.resolve(err(new ExecutionError('shell_unavailable', 'Host shell execution requires explicit trusted mode or an isolated execution backend')));
      if (property === 'joinPath') return async (parts: string[]) => {
        try { return ok(await guard(join(...parts))); } catch (error) { return err(asFileError(error)); }
      };
      if (property === 'createTempDir' || property === 'createTempFile') return async (input: string | { prefix?: string; suffix?: string } | undefined, context: Context) => {
        if (mode === 'read-only') return err(denied(root, 'Workspace is read-only'));
        const prefix = typeof input === 'string' ? input : input?.prefix ?? 'tmp-';
        const suffix = typeof input === 'object' ? input.suffix ?? '' : '';
        if (!/^[a-zA-Z0-9._-]*$/.test(prefix + suffix)) return err(new FileError('invalid', 'Invalid temporary file name'));
        try {
          const path = await guard(join(root, '.morphess-tmp', `${prefix}${randomUUID()}${suffix}`), true);
          const result = property === 'createTempDir' ? await base.createDir(path, { recursive: true }, context) : await base.writeFile(path, '', context);
          return result.ok ? ok(path) : result;
        } catch (error) { return err(asFileError(error)); }
      };
      if (property === 'watch') return async (targets: Parameters<ExecutionEnv['watch']>[0], onChange: Parameters<ExecutionEnv['watch']>[1], context: Context) => {
        try {
          const guarded = await Promise.all(targets.map(async (item) => ({ ...item, path: await guard(item.path) })));
          return await base.watch(guarded, onChange, context);
        } catch (error) { return err(asFileError(error)); }
      };
      const method = Reflect.get(target, property) as unknown;
      if (typeof method !== 'function') return method;
      if (!pathMethods.has(String(property))) return method.bind(target) as unknown;
      return async (...args: unknown[]) => {
        try {
          if (writeMethods.has(String(property)) && mode === 'read-only') throw denied(String(args[0]), 'Workspace is read-only');
          args[0] = await guard(args[0], writeMethods.has(String(property)));
          if (property === 'remove' || property === 'renameFile') { protectedSubtreeMutation(String(args[0])); protectedSubtreeMutation(await canonicalizeMissing(String(args[0]))); }
          if (property === 'renameFile') { args[1] = await guard(args[1], true); protectedSubtreeMutation(String(args[1])); protectedSubtreeMutation(await canonicalizeMissing(String(args[1]))); }
          const result = await Reflect.apply(method, target, args) as unknown;
          const visible = (entry: { path: string }): boolean => {
            try { checkProtected(entry.path, false); return true; } catch { return false; }
          };
          if (property === 'listDir') {
            const listing = result as Awaited<ReturnType<ExecutionEnv['listDir']>>;
            return listing.ok ? ok(listing.value.filter(visible)) : listing;
          }
          if (property === 'openDirReader') {
            const opened = result as Awaited<ReturnType<ExecutionEnv['openDirReader']>>;
            if (!opened.ok) return opened;
            const reader = opened.value;
            return ok({
              async next(maxEntries: number, context: Context) {
                const page = await reader.next(maxEntries, context);
                return page.ok ? ok({ ...page.value, entries: page.value.entries.filter(visible) }) : page;
              },
              close: reader.close.bind(reader),
            });
          }
          return result;
        } catch (error) { return err(asFileError(error, String(args[0]))); }
      };
    },
    set() { throw new Error('Workspace environment configuration is immutable'); },
  }) as unknown as WorkspaceExecutionEnv;
  return env;
}
