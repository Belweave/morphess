import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable';
import { createWorkspaceEnvironment } from '../src/policy/workspace.js';
import { createWorkspaceTools, listWorkspaceFiles } from '../src/tools/workspace.js';
const context = BACKGROUND_CONTEXT;
let fixture: string;
let workspace: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'morphess-tools-')); workspace = join(fixture, 'workspace');
  await mkdir(workspace); await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src', 'hello.ts'), 'Hello agent\nneedle in code\n');
  await mkdir(join(workspace, 'node_modules')); await writeFile(join(workspace, 'node_modules', 'ignored.ts'), 'needle');
  await writeFile(join(fixture, 'outside.txt'), 'private needle');
  await symlink(join(fixture, 'outside.txt'), join(workspace, 'escape.txt'));
});
afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });
function text(result: ToolExecutionResult): string { return result.output?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? ''; }
async function run(name: string, args: Record<string, unknown>, maxOutputBytes = 4096) {
  const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only', maxOutputBytes });
  try {
    const tool = createWorkspaceTools({ workspace, maxOutputBytes }).tools!.find((item) => item.name === name)!;
    return await tool.execute(args, { env } as unknown as ToolExecutionApi, context);
  } finally { await env.cleanup(context); }
}
describe('workspace tools', () => {
  it('lists files without traversing symlinks or dependencies and supports a portable fallback', async () => {
    const listed = text(await run('list_files', {}));
    expect(listed).toContain('src/hello.ts');
    expect(listed).not.toContain('ignored.ts');
    const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    const portable = new Proxy(env, { get(target, key) { if (key === 'readOnlyCommand') return undefined; return Reflect.get(target, key); } });
    expect((await listWorkspaceFiles(portable, '.', context)).paths).toContain('src/hello.ts');
  });
  it('searches literal queries, ignores escaped symlinks, and reports incomplete coverage', async () => {
    const found = await run('search', { query: 'needle' });
    expect(text(found)).toContain('src/hello.ts:2:needle in code');
    expect(text(found)).not.toContain('private needle');
    expect(text(found)).not.toContain('node_modules');
    expect(text(await run('search', { query: '--help' }))).toContain('No matches');
    expect(text(await run('search', { query: 'hello', caseSensitive: false }))).toContain('Hello agent');
    expect(text(await run('search', { query: 'needle', path: 'src/hello.ts' }))).toContain('src/hello.ts:2:');
  });
  it('rejects path traversal and does not interpret search values as argv', async () => {
    await expect(run('search', { query: 'private', path: '..' })).rejects.toThrow('outside');
    await expect(run('list_files', { path: '../outside.txt' })).rejects.toThrow('outside');
    await writeFile(join(workspace, '--no-ignore'), 'needle');
    const found = text(await run('search', { query: 'needle', path: '--no-ignore' }));
    expect(found).toContain('--no-ignore:1:needle');
  });
  it('bounds output and tells the model when limits omit results', async () => {
    await writeFile(join(workspace, 'many.txt'), ('needle ' + 'x'.repeat(900) + '\n').repeat(100));
    const found = await run('search', { query: 'needle', maxResults: 100 }, 512);
    expect(Buffer.byteLength(text(found))).toBeLessThanOrEqual(512);
    expect(text(found)).toContain('truncated');
  });
  it('uses guarded fixed argv git capabilities without granting shell permission', async () => {
    execFileSync('git', ['init', '--quiet', workspace]);
    const status = text(await run('git_status', {}));
    expect(status).toContain('src/');
    const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    expect((await env.exec('git status', {}, context)).ok).toBe(false);
    expect((await env.readOnlyCommand({ kind: 'git-diff', path: '../outside.txt' }, {}, context)).ok).toBe(false);
    execFileSync('git', ['-C', workspace, 'add', '--', 'src/hello.ts']);
    await writeFile(join(workspace, 'src', 'hello.ts'), 'changed\n');
    expect(text(await run('git_diff', { path: 'src/hello.ts' }))).toContain('+changed');
  });
  it('excludes accidentally tracked harness state from unscoped Git diffs', async () => {
    execFileSync('git', ['init', '--quiet', workspace]);
    await mkdir(join(workspace, '.morphess'));
    await writeFile(join(workspace, '.morphess', 'session.json'), 'old secret');
    execFileSync('git', ['-C', workspace, 'add', '--force', '--', '.morphess/session.json']);
    await writeFile(join(workspace, '.morphess', 'session.json'), 'new private session contents');
    const diff = text(await run('git_diff', {}));
    expect(diff).not.toContain('private session');
    expect(diff).toBe('(clean)');
  });
  it('declares every workspace tool replay-safe', () => {
    for (const tool of createWorkspaceTools({ workspace, maxOutputBytes: 512 }).tools!) expect(tool.replay).toBe('safe');
  });
});
