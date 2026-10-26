import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable';
import { getOrThrow, type ExecutionEnv } from '@earendil-works/pi-durable/env';
import { createWorkspaceEnvironment, truncateUtf8 } from '../policy/workspace.js';
import { listWorkspaceFiles } from '../tools/workspace.js';

const MAX_INSTRUCTIONS_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_SKILLS = 100;
interface Skill { name: string; description: string; path: string; }

/** Bounded opened-file read; symlinks in the final component are refused. */
export async function readInstructionFile(env: ExecutionEnv, path: string, limit: number, context: Context): Promise<string | undefined> {
  const opened = await env.openBinaryReader(path, { noFollow: true }, context);
  if (!opened.ok) {
    if (opened.error.code === 'not_found') return undefined;
    throw opened.error;
  }
  try {
    const info = getOrThrow(await opened.value.info(context));
    const bytes = getOrThrow(await opened.value.read(0, limit, context));
    const text = truncateUtf8(new TextDecoder().decode(bytes), limit);
    return text + (info.size > limit ? '\n[Instruction file truncated; consult the source for the remaining instructions.]' : '');
  } finally { await opened.value.close(context); }
}
function frontmatter(text: string, key: string): string | undefined {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return undefined;
  const header = text.split(/\r?\n---(?:\r?\n|$)/, 1)[0] ?? '';
  const match = header.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!match) return undefined;
  let value = match[1]!.trim();
  if (value === '>' || value === '|') {
    const remainder = header.slice(match.index! + match[0].length);
    value = remainder.split(/\r?\n/).filter((line) => /^\s+\S/.test(line)).map((line) => line.trim()).join(' ');
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return truncateUtf8(value, 500);
}
function contained(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rest = relative(root, absolute);
  if (isAbsolute(rest) || rest === '..' || rest.startsWith(`..${sep}`)) throw new Error('Instruction path is outside the workspace');
  return absolute;
}

/**
 * Root instructions are supplied eagerly. Nested instructions and skill bodies
 * are disclosed only through read-only, replay-safe Pi tools. No skill executes
 * code merely because it was discovered.
 */
export async function createInstructionExtension(options: { workspace: string }): Promise<Extension> {
  const startupEnv = await createWorkspaceEnvironment({ workspace: options.workspace, mode: 'read-only', maxOutputBytes: 512 * 1024 });
  const context = BACKGROUND_CONTEXT;
  const root = startupEnv.cwd;
  let rootInstructions: string | undefined;
  const skills: Skill[] = [];
  const nestedInstructions: string[] = [];
  try {
    rootInstructions = await readInstructionFile(startupEnv, join(root, 'AGENTS.md'), MAX_INSTRUCTIONS_BYTES, context);
    // Read the skill directory directly so .gitignore cannot hide trusted skill
    // metadata from discovery. No recursive repository-wide scan is required.
    const directory = await startupEnv.openDirReader(join(root, '.agents', 'skills'), context);
    if (directory.ok) {
      try {
        let done = false;
        while (!done && skills.length < MAX_SKILLS) {
          const page = getOrThrow(await directory.value.next(128, context));
          done = page.done;
          for (const item of page.entries) {
            if (item.kind !== 'directory' || skills.length >= MAX_SKILLS) continue;
            const path = join('.agents', 'skills', item.name, 'SKILL.md');
            const text = await readInstructionFile(startupEnv, join(root, path), 16 * 1024, context);
            if (text === undefined) continue;
            skills.push({ name: item.name, description: frontmatter(text, 'description') ?? `Workspace skill ${item.name}`, path });
          }
        }
      } finally { await directory.value.close(context); }
    } else if (directory.error.code !== 'not_found') throw directory.error;
    const listing = await listWorkspaceFiles(startupEnv, '.', context, 128 * 1024);
    nestedInstructions.push(...listing.paths.filter((path) => basename(path) === 'AGENTS.md' && path !== 'AGENTS.md').slice(0, 100));
  } finally { await startupEnv.cleanup(context); }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const catalog = skills.map((skill) => `- ${JSON.stringify(skill.name)}: ${skill.description}`).join('\n');
  return defineExtension({
    name: 'morphess-instructions',
    sections: [section('workspace_instructions', () => [
      'Workspace guidance applies within its directory, subject to higher-priority host and user instructions. Before working in a subdirectory, call read_instructions for the target path; deeper AGENTS.md files override parent guidance within their scope.',
      rootInstructions ? `Root AGENTS.md:\n${rootInstructions}` : 'No root AGENTS.md was found.',
      nestedInstructions.length ? `Discovered nested instruction files (bounded listing):\n${nestedInstructions.join('\n')}` : '',
      catalog ? `Available workspace skills (metadata only; call load_skill before applying a skill):\n${catalog}` : '',
    ].filter(Boolean).join('\n\n'))],
    tools: [
      defineTool({
        name: 'read_instructions',
        description: 'Load AGENTS.md guidance from the workspace root through the target directory, in precedence order. Call before working in a subdirectory. Bounded to 128 KiB total.',
        parameters: Type.Object({ path: Type.String({ description: 'Workspace relative target file or directory' }) }),
        replay: 'safe',
        outputLimits: { maxBytes: MAX_TOTAL_BYTES, retain: 'head' },
        async execute(args, api, ctx) {
          if (!api.env) throw new Error('Instructions require an execution environment');
          const env = api.env;
          const target = contained(env.cwd, args.path);
          const info = await env.fileInfo(target, ctx);
          if (!info.ok && info.error.code !== 'not_found') throw info.error;
          const directory = info.ok && info.value.kind === 'directory' ? target : dirname(target);
          const segments = relative(env.cwd, directory).split(sep).filter(Boolean);
          const output: string[] = [];
          let current = env.cwd;
          let total = 0;
          for (let index = 0; index <= segments.length; index++) {
            if (index > 0) current = join(current, segments[index - 1]!);
            const path = join(current, 'AGENTS.md');
            const text = await readInstructionFile(env, path, Math.min(MAX_INSTRUCTIONS_BYTES, MAX_TOTAL_BYTES - total), ctx);
            if (text === undefined) continue;
            const rendered = `${relative(env.cwd, path)}:\n${text}`;
            total += Buffer.byteLength(rendered) + 2;
            output.push(rendered);
            if (total >= MAX_TOTAL_BYTES) { output.push('[Instruction budget exhausted.]'); break; }
          }
          return { output: [{ type: 'text', text: truncateUtf8(output.join('\n\n') || 'No applicable AGENTS.md files found.', MAX_TOTAL_BYTES) }] };
        },
      }),
      defineTool({
        name: 'load_skill',
        description: 'Load a discovered .agents/skills/<name>/SKILL.md body. Loading gives instructions only; it does not execute scripts or grant additional permissions.',
        parameters: Type.Object({ name: Type.String({ description: 'Exact catalog skill name (directory name)' }) }),
        replay: 'safe',
        outputLimits: { maxBytes: MAX_INSTRUCTIONS_BYTES, retain: 'head' },
        async execute(args, api, ctx) {
          const skill = skills.find((item) => item.name === args.name);
          if (!skill) throw new Error(`Unknown skill: ${args.name}`);
          if (!api.env) throw new Error('Skills require an execution environment');
          const text = await readInstructionFile(api.env, join(api.env.cwd, skill.path), MAX_INSTRUCTIONS_BYTES, ctx);
          if (text === undefined) throw new Error(`Skill no longer exists: ${skill.name}`);
          return { output: [{ type: 'text', text }], details: { name: skill.name, path: skill.path } };
        },
      }),
    ],
  });
}
