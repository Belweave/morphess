import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig, loadConfig, morphessConfigSchema } from '../src/config.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'morphess-config-')); dirs.push(dir); return dir; }

it('defaults to an explicit million-token model and workspace-write policy', async () => {
  const cwd = await workspace();
  expect(await loadConfig({ cwd, env: {} })).toEqual(defaultConfig(cwd));
});

it('merges nested settings, resolves paths, and applies explicit environment overrides', async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, 'morphess.json'), JSON.stringify({ workspace: 'project', model: { id: 'file-model' }, server: { port: 9001 } }));
  const config = await loadConfig({ cwd, env: { MORPHESS_MODEL: 'env-model', MORPHESS_API: 'responses' } });
  expect(config.model.id).toBe('env-model');
  expect(config.model.api).toBe('responses');
  expect(config.model.contextWindow).toBe(1_000_000);
  expect(config.workspace).toBe(join(cwd, 'project'));
  expect(config.stateDir).toBe(join(cwd, 'project', '.morphess'));
  expect(config.server.port).toBe(9001);
});

it('fails for a missing explicit config, unknown fields, malformed URLs and unsupported modalities', async () => {
  const cwd = await workspace();
  await expect(loadConfig({ cwd, path: 'missing.json', env: {} })).rejects.toThrow();
  const base = defaultConfig(cwd);
  expect(() => morphessConfigSchema.parse({ ...base, typo: true })).toThrow();
  expect(() => morphessConfigSchema.parse({ ...base, model: { ...base.model, baseUrl: 'https://user:secret@example.com/v1' } })).toThrow('without embedded credentials');
  expect(() => morphessConfigSchema.parse({ ...base, model: { ...base.model, input: ['text', 'video'] } })).toThrow('require an explicit adapter');
});

it('rejects impossible context budgets and unknown prices with spending limits', () => {
  const base = defaultConfig('/tmp/workspace');
  expect(() => morphessConfigSchema.parse({ ...base, model: { ...base.model, contextWindow: 4096 } })).toThrow();
  expect(() => morphessConfigSchema.parse({ ...base, limits: { ...base.limits, maxSpendUsd: 1 } })).toThrow('explicit per-million-token');
});

it('validates MCP environment references and rejects duplicate server names', () => {
  const base = defaultConfig('/tmp/workspace');
  const mcp = [{ name: 'docs', transport: 'stdio', command: 'node', env: { TOKEN: 'MCP_TOKEN' } }];
  expect(morphessConfigSchema.parse({ ...base, mcp }).mcp[0]?.timeoutMs).toBe(30_000);
  expect(() => morphessConfigSchema.parse({ ...base, mcp: [...mcp, ...mcp] })).toThrow('names must be unique');
  expect(() => morphessConfigSchema.parse({ ...base, mcp: [{ ...mcp[0], env: { TOKEN: 'secret-key-value' } }] })).toThrow('environment variable name');
});

it('resolves MCP working directories against the selected config file', async () => {
  const cwd = await workspace();
  await writeFile(join(cwd, 'custom.json'), JSON.stringify({ mcp: [{ name: 'docs', transport: 'stdio', command: 'node', cwd: './mcp-server' }] }));
  const config = await loadConfig({ cwd, path: 'custom.json', env: {} });
  const server = config.mcp[0]!;
  expect(server.transport).toBe('stdio');
  if (server.transport === 'stdio') expect(server.cwd).toBe(join(cwd, 'mcp-server'));
});
