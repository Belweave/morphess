import { mkdtemp, readFile, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { readMaskedApiKey, writeProviderConfiguration } from '../src/cli/provider.js';
import { canonicalProviderEndpoint, deleteProviderCredential, getProviderCredentialStatus, providerCredentialDirectory, providerCredentialPath, readProviderCredential, saveProviderCredential } from '../src/models/credentials.js';

it('defaults to Morph general coding while allowing explicit provider configuration', () => {
  expect(defaultConfig('/tmp/example').model).toMatchObject({ baseUrl: 'https://api.morphllm.com/v1', id: 'morph-kimik3', apiKeyEnv: 'MORPH_API_KEY' });
});
it('scopes private keys by exact canonical endpoint, restricts modes, and redacts status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'morphess-provider-')); const env = { XDG_CONFIG_HOME: root };
  const endpoint = 'https://example.test/v1'; const key = 'fixture-private-key';
  await saveProviderCredential(endpoint, key, env);
  expect((await stat(providerCredentialDirectory(env))).mode & 0o777).toBe(0o700);
  expect((await stat(providerCredentialPath(endpoint, env))).mode & 0o777).toBe(0o600);
  expect(await readProviderCredential('https://EXAMPLE.test:443/v1', env)).toBe(key);
  for (const other of ['https://example.test/v2', 'https://example.test/v1/', 'http://example.test/v1', 'https://example.test/v1?q=1']) expect(await readProviderCredential(other, env)).toBeUndefined();
  const status = await getProviderCredentialStatus({ baseUrl: endpoint, apiKeyEnv: 'TEST_KEY' }, env);
  expect(status).toEqual({ authenticated: true, source: 'private-store' }); expect(JSON.stringify(status)).not.toContain(key);
  expect(await getProviderCredentialStatus({ baseUrl: endpoint, apiKeyEnv: 'TEST_KEY' }, { ...env, TEST_KEY: 'environment-key' })).toEqual({ authenticated: true, source: 'environment' });
  await deleteProviderCredential(endpoint, env); expect(await readProviderCredential(endpoint, env)).toBeUndefined();
});
it('rejects credential links, foreign scopes and permissive files without revealing contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'morphess-provider-')); const env = { XDG_CONFIG_HOME: root }; const endpoint = 'https://example.test/v1';
  await mkdir(providerCredentialDirectory(env), { recursive: true, mode: 0o700 });
  const target = join(root, 'target'); await writeFile(target, 'fixture-secret', { mode: 0o600 });
  await symlink(target, providerCredentialPath(endpoint, env));
  await expect(readProviderCredential(endpoint, env)).rejects.toThrow('safely open');
  expect(() => canonicalProviderEndpoint('https://key@example.test/v1')).toThrow();
});
it('atomically preserves unrelated raw config and avoids environment overlays and credential forwarding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'morphess-config-')); const path = join(root, 'morphess.json');
  await writeFile(path, JSON.stringify({ policy: { mode: 'read-only' }, model: { baseUrl: 'https://api.morphllm.com/v1', apiKeyEnv: 'MORPH_API_KEY', contextWindow: 500000 } }));
  await writeProviderConfiguration(path, { baseUrl: 'https://other.test/v1', model: 'other-id' });
  const config = JSON.parse(await readFile(path, 'utf8'));
  expect(config).toEqual({ policy: { mode: 'read-only' }, model: { baseUrl: 'https://other.test/v1', apiKeyEnv: 'MORPHESS_API_KEY', contextWindow: 500000, id: 'other-id' } });
  await writeProviderConfiguration(path, { keyEnv: 'CUSTOM_KEY' }); expect(JSON.parse(await readFile(path, 'utf8')).model.apiKeyEnv).toBe('CUSTOM_KEY');
  const before = await readFile(path, 'utf8'); await expect(writeProviderConfiguration(path, { api: 'invalid' as 'responses' })).rejects.toThrow(); expect(await readFile(path, 'utf8')).toBe(before);
});
function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; return this; } });
  const output = new PassThrough(); let rendered = ''; output.on('data', chunk => { rendered += chunk.toString(); });
  return { input, output, rendered: () => rendered };
}
it('masks pasted key input, handles split paste delimiters and restores raw mode/listeners', async () => {
  const { input, output, rendered } = terminal(); const listeners = process.listenerCount('SIGINT');
  const promise = readMaskedApiKey(input, output); input.write('\x1b[20'); input.write('0~fixture-'); input.write('secret\n\x1b[201~'); input.write('\r');
  expect(await promise).toBe('fixture-secret'); expect(rendered()).not.toContain('fixture-secret'); expect(input.isRaw).toBe(false); expect(input.listenerCount('data')).toBe(0); expect(process.listenerCount('SIGINT')).toBe(listeners);
});
it('cancels masked entry on Ctrl-C and rejects nonterminal secret pipes', async () => {
  const { input, output, rendered } = terminal(); const promise = readMaskedApiKey(input, output); input.write('fixture-secret\x03');
  await expect(promise).rejects.toThrow('cancelled'); expect(input.isRaw).toBe(false); expect(rendered()).not.toContain('fixture-secret');
  input.isTTY = false; await expect(readMaskedApiKey(input, output)).rejects.toThrow('interactive terminal');
});

it('resolves private keys on provider calls, honors environment priority, and never reuses another endpoint key', async () => {
  const { createServer } = await import('node:http');
  const { createModelRuntime } = await import('../src/models/runtime.js');
  const root = await mkdtemp(join(tmpdir(), 'morphess-provider-')); const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root };
  const authorizations: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume local fixture request */ }
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture missing port');
    const config = defaultConfig(root); config.model.baseUrl = `http://127.0.0.1:${address.port}/v1`; config.model.apiKeyEnv = 'CUSTOM_TEST_KEY';
    await saveProviderCredential(config.model.baseUrl, 'fixture-saved-key', env);
    const runtime = createModelRuntime(config, env); const model = runtime.models.getModel(runtime.model.provider, runtime.model.modelId)!;
    const context = { messages: [{ role: 'user' as const, content: 'test', timestamp: 1 }] };
    expect((await runtime.models.completeSimple(model, context)).stopReason).toBe('stop');
    env.CUSTOM_TEST_KEY = 'fixture-env-key'; await runtime.models.completeSimple(model, context);
    expect(authorizations).toEqual(['Bearer fixture-saved-key', 'Bearer fixture-env-key']);
    delete env.CUSTOM_TEST_KEY; config.model.baseUrl += '/other';
    const other = createModelRuntime(config, env); const result = await other.models.completeSimple(other.models.getModel(other.model.provider, other.model.modelId)!, context);
    expect(result.errorMessage).toContain('Missing CUSTOM_TEST_KEY'); expect(authorizations).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('fixture-saved-key');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('restores terminal state on a process SIGINT without leaking the partial key', async () => {
  const { input, output, rendered } = terminal(); const count = process.listenerCount('SIGINT');
  const promise = readMaskedApiKey(input, output); input.write('fixture-partial'); process.emit('SIGINT');
  await expect(promise).rejects.toThrow('cancelled'); expect(input.isRaw).toBe(false); expect(input.listenerCount('data')).toBe(0); expect(process.listenerCount('SIGINT')).toBe(count); expect(rendered()).not.toContain('fixture-partial');
});

it.skipIf(process.platform === 'win32')('rejects credential FIFOs without blocking', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'morphess-provider-')); const env = { XDG_CONFIG_HOME: root }; const endpoint = 'https://example.test/v1';
  await mkdir(providerCredentialDirectory(env), { recursive: true, mode: 0o700 });
  execFileSync('mkfifo', [providerCredentialPath(endpoint, env)]);
  await expect(readProviderCredential(endpoint, env)).rejects.toThrow('regular file');
});
