import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, link, mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createEditTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { WORKSPACE_FILE_LIMITS } from '../src/policy/files.js';
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
  it.skipIf(process.platform === 'win32')('rejects special files across reads and writes without opening blocking streams', async () => {
    const pipe = join(workspace, 'pipe'); execFileSync('mkfifo', [pipe]);
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    for (const operation of [
      () => env.readTextFile('pipe', context), () => env.readBinaryFile('pipe', context),
      () => env.openTextLineReader('pipe', context), () => env.readTextLines('pipe', {}, context),
      () => env.openBinaryReader('pipe', {}, context), () => env.writeFile('pipe', 'bad', context),
      () => env.appendFile('pipe', 'bad', context), () => env.truncateFile('pipe', 0, context), () => env.flushFile('pipe', context),
    ]) expect((await operation()).ok).toBe(false);
  });
  it('rejects oversized full reads, line scans and individual lines with bounded alternatives', async () => {
    const path = join(workspace, 'sparse.log'); const handle = await open(path, 'w');
    await handle.truncate(WORKSPACE_FILE_LIMITS.scanBytes + 1); await handle.close();
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    const full = await env.readTextFile('sparse.log', context);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error.message).toContain('read_bytes');
    const opened = await env.openBinaryReader('sparse.log', {}, context);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect((await opened.value.read(0, WORKSPACE_FILE_LIMITS.positionalReadBytes + 1, context)).ok).toBe(false);
      expect((await opened.value.scanLines({ startLine: 0, endLine: 1 }, context)).ok).toBe(false);
      expect((await opened.value.read(0, 16, context)).ok).toBe(true);
      await opened.value.close(context);
    }
    await writeFile(join(workspace, 'long-line'), 'x'.repeat(WORKSPACE_FILE_LIMITS.lineBytes + 1));
    const lines = await env.openTextLineReader('long-line', context);
    if (!lines.ok) throw lines.error;
    try { expect((await lines.value.readLine(context)).ok).toBe(false); } finally { await lines.value.close(context); }
  });
  it('preserves byte-order marks during Pi full-file edits and handles bounded line reads', async () => {
    await writeFile(join(workspace, 'bom.ts'), '\uFEFFbefore\nline two');
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    await createEditTool().execute({ path: 'bom.ts', edits: [{ oldText: 'before', newText: 'after' }] }, { env } as unknown as ToolExecutionApi, context);
    expect(await readFile(join(workspace, 'bom.ts'), 'utf8')).toBe('\uFEFFafter\nline two');
    expect(await env.readTextLines('bom.ts', { maxLines: 1 }, context)).toEqual({ ok: true, value: ['after'] });
  });
  it('keeps interior byte-order marks at chunk boundaries during line reads', async () => {
    const text = 'x'.repeat(64 * 1024) + '\uFEFFtail';
    await writeFile(join(workspace, 'chunked'), text);
    const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    expect(await env.readTextLines('chunked', {}, context)).toEqual({ ok: true, value: [text] });
  });
  it('blocks mutation through hard links to files outside the workspace', async () => {
    await link(join(outside, 'secret'), join(workspace, 'hardlink'));
    const env = await createWorkspaceEnvironment({ workspace, mode: 'workspace-write' });
    expect((await env.writeFile('hardlink', 'changed', context)).ok).toBe(false);
    expect((await env.appendFile('hardlink', 'changed', context)).ok).toBe(false);
    expect((await env.truncateFile('hardlink', 0, context)).ok).toBe(false);
    expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('outside-secret');
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
    const env = await createWorkspaceEnvironment({ workspace, mode: 'trusted', maxOutputBytes: 127, shellTimeoutMs: 5000 });
    try {
      let output = '';
      const result = await env.exec([process.execPath, '-e', 'process.stdout.write("🌍".repeat(10000))'], { onOutput(chunk) { output += chunk; } }, context);
      expect(result.ok).toBe(true);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(127);
      expect(output).not.toContain('\uFFFD');
      const timed = await env.exec([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeout: 0.1 }, context);
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
