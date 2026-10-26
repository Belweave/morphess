import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createEditTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { createWorkspaceEnvironment, truncateUtf8 } from '../src/policy/workspace.js';

const context = BACKGROUND_CONTEXT;
let fixture: string;
let workspace: string;
let outside: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'morphess-policy-'));
  workspace = join(fixture, 'workspace'); outside = join(fixture, 'outside');
  await mkdir(workspace); await mkdir(outside);
  await writeFile(join(outside, 'secret'), 'outside-secret');
  await writeFile(join(workspace, 'source.ts'), 'before');
});
afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });

describe('workspace file capability', () => {
  it('permits contained absolute and relative paths and denies traversal/absolute escape', async () => {
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    expect(await env.readTextFile('source.ts', context)).toEqual({ ok: true, value: 'before' });
    expect((await env.readTextFile(join(env.cwd, 'source.ts'), context)).ok).toBe(true);
    for (const path of ['../outside/secret', join(outside, 'secret'), '../workspace-sibling/new', 'bad\0path']) {
      expect((await env.readTextFile(path, context)).ok).toBe(false);
      expect((await env.writeFile(path, 'bad', context)).ok).toBe(false);
    }
    expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('outside-secret');
  });
  it('blocks existing and dangling symlink escapes for reads, creates, renames, and watches', async () => {
    await symlink(outside, join(workspace, 'escape'));
    await symlink(join(outside, 'missing'), join(workspace, 'dangling'));
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    expect((await env.readTextFile('escape/secret', context)).ok).toBe(false);
    expect((await env.writeFile('escape/new/nested', 'bad', context)).ok).toBe(false);
    expect((await env.createDir('escape/new', { recursive: true }, context)).ok).toBe(false);
    expect((await env.writeFile('dangling/child', 'bad', context)).ok).toBe(false);
    expect((await env.renameFile('source.ts', 'escape/secret', context)).ok).toBe(false);
    expect((await env.watch([{ path: 'escape', recursive: true }], () => {}, context)).ok).toBe(false);
    expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('outside-secret');
  });
  it('allows an internal symlink but blocks readonly mutations across the entire env', async () => {
    await symlink(join(workspace, 'source.ts'), join(workspace, 'internal'));
    const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    expect((await env.readTextFile('internal', context)).ok).toBe(true);
    const operations = [env.writeFile('source.ts', 'bad', context), env.appendFile('source.ts', 'bad', context), env.truncateFile('source.ts', 0, context), env.renameFile('source.ts', 'other', context), env.remove('source.ts', {}, context), env.createDir('new', {}, context), env.createTempDir('tmp-', context), env.createTempFile({}, context)];
    for (const operation of await Promise.all(operations)) expect(operation.ok).toBe(false);
    expect(await readFile(join(workspace, 'source.ts'), 'utf8')).toBe('before');
  });
  it('places temporary files inside workspace and rejects path fragments in prefixes', async () => {
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    const temporary = await env.createTempFile({ prefix: 'unit-', suffix: '.txt' }, context);
    expect(temporary.ok).toBe(true);
    if (temporary.ok) expect(temporary.value.startsWith(env.cwd + '/')).toBe(true);
    expect((await env.createTempDir('../escape/', context)).ok).toBe(false);
    expect(() => { env.cwd = outside; }).toThrow('immutable');
  });
  it('protects session state and Git metadata, including aliases and recursive ancestor removal', async () => {
    await mkdir(join(workspace, '.morphess'));
    await writeFile(join(workspace, '.morphess', 'session.sqlite'), 'authority');
    await mkdir(join(workspace, '.git'));
    await symlink(join(workspace, '.morphess'), join(workspace, 'state-alias'));
    await mkdir(join(workspace, 'data', 'private'), { recursive: true });
    await writeFile(join(workspace, 'data', 'private', 'config'), 'protected');
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write', protectedPaths: [join(workspace, 'data', 'private')] });
    for (const path of ['.morphess/session.sqlite', 'state-alias/session.sqlite', 'data/private/config']) {
      expect((await env.readTextFile(path, context)).ok).toBe(false);
      expect((await env.writeFile(path, 'bad', context)).ok).toBe(false);
    }
    expect((await env.writeFile('.git/hooks/pre-commit', 'bad', context)).ok).toBe(false);
    expect((await env.remove('.', { recursive: true }, context)).ok).toBe(false);
    expect((await env.remove('data', { recursive: true }, context)).ok).toBe(false);
    expect((await env.renameFile('data', 'other', context)).ok).toBe(false);
    const listing = await env.listDir('.', context);
    expect(listing.ok && listing.value.some((entry) => entry.name === '.morphess')).toBe(false);
    expect(await readFile(join(workspace, '.morphess', 'session.sqlite'), 'utf8')).toBe('authority');
  });
  it('cannot place temporary files in Git metadata through a directory alias', async () => {
    await mkdir(join(workspace, '.git'));
    await symlink(join(workspace, '.git'), join(workspace, '.morphess-tmp'));
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    expect((await env.createTempFile({}, context)).ok).toBe(false);
  });
  it('does not execute a repository-controlled rg from npm-style PATH', async () => {
    const bin = join(workspace, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    const marker = join(workspace, 'executed');
    await writeFile(join(bin, 'rg'), '#!/bin/sh\necho bad > ' + JSON.stringify(marker) + '\n');
    await chmod(join(bin, 'rg'), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
      await env.readOnlyCommand({ kind: 'list-files', path: '.' }, {}, context);
      await expect(readFile(marker)).rejects.toThrow();
    } finally { process.env.PATH = previous; }
  });
  it('enforces policy when called by Pi built-in write and edit tools', async () => {
    const readonly = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    const deniedApi = { env: readonly } as unknown as ToolExecutionApi;
    await expect(createWriteTool().execute({ path: 'source.ts', content: 'bad' }, deniedApi, context)).rejects.toThrow('read-only');
    await expect(createEditTool().execute({ path: 'source.ts', edits: [{ oldText: 'before', newText: 'bad' }] }, deniedApi, context)).rejects.toThrow('permission_denied');
    const writable = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    await createWriteTool().execute({ path: 'nested/new.ts', content: 'before' }, { env: writable } as unknown as ToolExecutionApi, context);
    await createEditTool().execute({ path: 'nested/new.ts', edits: [{ oldText: 'before', newText: 'after' }] }, { env: writable } as unknown as ToolExecutionApi, context);
    expect(await readFile(join(workspace, 'nested/new.ts'), 'utf8')).toBe('after');
  });
});

describe('host execution trust', () => {
  it.each(['read-only', 'workspace-write'] as const)('denies strings and argv in %s mode', async (mode) => {
    const env = await createWorkspaceEnvironment({ workspace, mode });
    for (const command of ['echo untrusted', [process.execPath, '-e', 'process.exit(0)']]) {
      const result = await env.exec(command, {}, context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('explicit trusted mode');
    }
  });
  it('bounds trusted command output in bytes, and enforces the host execution timeout', async () => {
    const env = await createWorkspaceEnvironment({ workspace, mode: 'trusted', maxOutputBytes: 127, shellTimeoutMs: 200 });
    try {
      let output = '';
      const result = await env.exec([process.execPath, '-e', 'process.stdout.write("🌍".repeat(10000))'], { onOutput(chunk) { output += chunk; } }, context);
      expect(result.ok).toBe(true);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(127);
      expect(output).not.toContain('\uFFFD');
      const timed = await env.exec([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeout: 30 }, context);
      expect(timed.ok).toBe(false);
      if (!timed.ok) expect(timed.error.code).toBe('timeout');
      expect((await env.exec('true', { cwd: outside }, context)).ok).toBe(false);
    } finally { await env.cleanup(context); }
  });
  it('preserves valid UTF-8 boundaries', () => {
    expect(truncateUtf8('a🌍b', 4)).toBe('a');
    expect(truncateUtf8('a🌍b', 5)).toBe('a🌍');
  });
});
