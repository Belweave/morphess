import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { PromptInput, ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable';
import { createInstructionExtension, readInstructionFile } from '../src/instructions/workspace.js';
import { createWorkspaceEnvironment } from '../src/policy/workspace.js';
let workspace: string;
const context = BACKGROUND_CONTEXT;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'morphess-instructions-'));
  await mkdir(join(workspace, 'src', 'nested'), { recursive: true });
  await mkdir(join(workspace, '.agents', 'skills', 'verify'), { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'Root rules.');
  await writeFile(join(workspace, 'src', 'AGENTS.md'), 'Source rules.');
  await writeFile(join(workspace, 'src', 'nested', 'file.ts'), 'code');
  await writeFile(join(workspace, '.agents', 'skills', 'verify', 'SKILL.md'), '---\nname: verification\ndescription: Check the implementation carefully.\n---\nSECRET SKILL BODY\nRun useful checks.');
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });
function text(result: ToolExecutionResult): string { return result.output?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? ''; }
describe('instruction and skill discovery', () => {
  it('eagerly supplies root guidance and skill metadata but progressively loads skill bodies', async () => {
    const extension = await createInstructionExtension({ workspace });
    const section = await extension.sections![0]!.render({} as PromptInput, context);
    expect(section).toContain('Root rules.');
    expect(section).toContain('Check the implementation carefully.');
    expect(section).toContain('src/AGENTS.md');
    expect(section).not.toContain('SECRET SKILL BODY');
    const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    const tool = extension.tools!.find((item) => item.name === 'load_skill')!;
    const loaded = await tool.execute({ name: 'verify' }, { env } as unknown as ToolExecutionApi, context);
    expect(text(loaded)).toContain('SECRET SKILL BODY');
    await expect(tool.execute({ name: '../verify' }, { env } as unknown as ToolExecutionApi, context)).rejects.toThrow('Unknown skill');
  });
  it('loads only applicable ancestor instructions in precedence order', async () => {
    await mkdir(join(workspace, 'other'));
    await writeFile(join(workspace, 'other', 'AGENTS.md'), 'Irrelevant rules.');
    const extension = await createInstructionExtension({ workspace });
    const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    const tool = extension.tools!.find((item) => item.name === 'read_instructions')!;
    const loaded = text(await tool.execute({ path: 'src/nested/file.ts' }, { env } as unknown as ToolExecutionApi, context));
    expect(loaded.indexOf('Root rules.')).toBeLessThan(loaded.indexOf('Source rules.'));
    expect(loaded).not.toContain('Irrelevant rules.');
    await expect(tool.execute({ path: '..' }, { env } as unknown as ToolExecutionApi, context)).rejects.toThrow('outside');
  });
  it('bounds instruction payloads', async () => {
    await writeFile(join(workspace, 'AGENTS.md'), 'x'.repeat(200_000));
    const extension = await createInstructionExtension({ workspace });
    const section = await extension.sections![0]!.render({} as PromptInput, context);
    expect(Buffer.byteLength(section!)).toBeLessThan(70_000);
    expect(section).toContain('truncated');
  });
  it('refuses symlinked skill bodies that could escape the workspace', async () => {
    await rm(join(workspace, '.agents', 'skills', 'verify', 'SKILL.md'));
    await symlink('/etc/passwd', join(workspace, '.agents', 'skills', 'verify', 'SKILL.md'));
    await expect(createInstructionExtension({ workspace })).rejects.toThrow('escapes');
  });
  it('honors custom protected paths during startup skill discovery', async () => {
    const extension = await createInstructionExtension({ workspace, protectedPaths: [join(workspace, '.agents', 'skills', 'verify')] });
    const rendered = await extension.sections![0]!.render({} as PromptInput, context);
    expect(rendered).not.toContain('Check the implementation carefully.');
    const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    await expect(extension.tools!.find((item) => item.name === 'load_skill')!.execute({ name: 'verify' }, { env } as unknown as ToolExecutionApi, context)).rejects.toThrow('Unknown skill');
  });
  it('includes truncation notices within the byte budget', async () => {
    await writeFile(join(workspace, 'AGENTS.md'), '🌍'.repeat(200));
    const env = await createWorkspaceEnvironment({ workspace, mode: 'read-only' });
    const rendered = await readInstructionFile(env, join(env.cwd, 'AGENTS.md'), 128, context);
    expect(Buffer.byteLength(rendered!)).toBeLessThanOrEqual(128);
    expect(rendered).toContain('truncated');
    expect(rendered).not.toContain('\uFFFD');
  });
  it('declares every instruction tool replay-safe', async () => {
    for (const tool of (await createInstructionExtension({ workspace })).tools!) expect(tool.replay).toBe('safe');
  });
});
