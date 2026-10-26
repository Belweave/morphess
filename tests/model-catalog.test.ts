import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defaultConfig } from '../src/config.js';
import { discoverModels, enrichModelList, parseModelList, profileForChoice, type ModelChoice } from '../src/models/catalog.js';
import { saveProviderCredential } from '../src/models/credentials.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { TuiController } from '../src/tui/controller.js';
import { serve } from '../src/http/server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-catalog-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture missing port');
  const config = defaultConfig(directory);
  config.model.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  config.model.apiKeyEnv = 'MORPHESS_CATALOG_FIXTURE_KEY'; config.model.allowUnauthenticated = true;
  return { config, directory };
}
const json = (res: ServerResponse, value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const small: ModelChoice = { id: 'small-text', name: 'Small text', contextWindow: 32768, maxOutputTokens: 4096, input: ['text'], source: 'provider' };

it('enriches an ID-only authenticated roster without adding public models or overriding explicit roster limits', () => {
  expect(enrichModelList([
    { id: 'small-text', name: 'small-text', source: 'provider' },
    { id: 'explicit', name: 'Account model', contextWindow: 64000, source: 'provider' },
  ], [small, { id: 'explicit', name: 'Public name', contextWindow: 1000000, source: 'provider' }, { id: 'unavailable', name: 'Not on account', source: 'provider' }])).toEqual([
    small, { id: 'explicit', name: 'Account model', contextWindow: 64000, source: 'provider' },
  ]);
});

it('parses explicit common and Morph metadata without inventing limits for ID-only entries', () => {
  expect(parseModelList({ data: [
    { id: 'id-only' }, { id: 'simple', context_length: 128000, max_output_tokens: 4096, input_modalities: ['text', 'image'] },
    { id: 'morph-rich', input_modalities: [{ type: 'text', supported_inputs: { max_context_length: { value: 1048576 } } }, { type: 'image' }], output_modalities: [{ type: 'text', max_length: { value: 32768 } }] },
    { id: 'audio-only', input_modalities: ['audio'] }, { id: 'bad\x1bid' },
  ] })).toEqual([
    { id: 'id-only', name: 'id-only', source: 'provider' },
    { id: 'morph-rich', name: 'morph-rich', contextWindow: 1048576, maxOutputTokens: 32768, input: ['text', 'image'], source: 'provider' },
    { id: 'simple', name: 'simple', contextWindow: 128000, maxOutputTokens: 4096, input: ['text', 'image'], source: 'provider' },
  ]);
});

it('uses saved endpoint credentials for GET /models and never sends the key through a redirect', async () => {
  const auth: Array<string | undefined> = []; let redirect = false; let redirected = 0;
  const { config, directory } = await fixture((req, res) => {
    if (req.url === '/steal') { redirected++; res.end(); return; }
    expect(req.method).toBe('GET'); expect(req.url).toBe('/v1/models'); auth.push(req.headers.authorization);
    if (redirect) { res.writeHead(302, { Location: '/steal' }); res.end(); } else json(res, { data: [{ id: 'listed' }] });
  });
  const env = { XDG_CONFIG_HOME: directory };
  await saveProviderCredential(config.model.baseUrl, 'fixture-catalog-key', env);
  expect(await discoverModels(config.model, { env })).toMatchObject([{ id: 'listed' }]);
  redirect = true; await expect(discoverModels(config.model, { env })).rejects.toThrow('HTTP 302');
  expect(auth).toEqual(['Bearer fixture-catalog-key', 'Bearer fixture-catalog-key']); expect(redirected).toBe(0);
});

it('enriches Morph capabilities with a separate keyless request and preserves account availability', async () => {
  const config = defaultConfig('/tmp/example'); const requests: Array<{ url: string; auth: string | null }> = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input); requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return Response.json(url === 'https://api.morphllm.com/v1/models' ? { data: [{ id: 'small-text' }] } : { data: [{ id: 'small-text', context_length: 32768, input_modalities: ['text'] }, { id: 'unavailable' }] });
  });
  try {
    expect(await discoverModels(config.model, { env: { MORPH_API_KEY: 'fixture-key' } })).toMatchObject([{ id: 'small-text', contextWindow: 32768, input: ['text'] }]);
    expect(requests).toEqual([{ url: 'https://api.morphllm.com/v1/models', auth: 'Bearer fixture-key' }, { url: 'https://www.morphllm.com/api/models/json', auth: null }]);
  } finally { fetch.mockRestore(); }
});

it('redacts provider error bodies and bounds malformed catalogs', async () => {
  let response: 'error' | 'invalid' | 'large' = 'error';
  const { config } = await fixture((_req, res) => {
    if (response === 'error') { res.writeHead(401); res.end('private provider diagnostic'); }
    else if (response === 'invalid') res.end('invalid private diagnostic');
    else res.end('x'.repeat(4 * 1024 * 1024 + 1));
  });
  await expect(discoverModels(config.model)).rejects.toThrow('HTTP 401');
  response = 'invalid'; await expect(discoverModels(config.model)).rejects.toThrow('invalid JSON');
  response = 'large'; await expect(discoverModels(config.model)).rejects.toThrow('exceeds 4 MiB');
});

it('caches model discovery until explicit refresh without changing the configured profile', async () => {
  let requests = 0;
  const { config } = await fixture((_req, res) => { requests++; json(res, { data: [{ id: `model-${requests}` }] }); });
  const runtime = await MorphessRuntime.open(config); cleanup.push(() => runtime.close());
  expect((await runtime.models()).some(model => model.id === 'model-1')).toBe(true);
  await runtime.models(); expect(requests).toBe(1);
  expect((await runtime.models({ refresh: true })).some(model => model.id === 'model-2')).toBe(true);
  expect(requests).toBe(2); expect(runtime.config.model.id).toBe(config.model.id);
});

it('switches the native session, uses the new model and output limit, and restores it without discovery on reopen', async () => {
  const payloads: Record<string, unknown>[] = [];
  const { config } = await fixture((req, res) => {
    expect(req.url).toBe('/v1/chat/completions');
    void (async () => {
      let body = ''; for await (const chunk of req) body += chunk;
      payloads.push(JSON.parse(body)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'reply', choices: [{ index: 0, delta: { content: 'Selected model answered' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    })();
  });
  const runtime = await MorphessRuntime.open(config); cleanup.push(() => runtime.close());
  const controller = await TuiController.open(runtime); cleanup.push(() => controller.close());
  await controller.setModel(small);
  expect(controller.state.model).toBe(small.id); expect(controller.state.context?.contextWindow).toBe(32768);
  expect((await runtime.root.agent(BACKGROUND_CONTEXT)).model?.modelId).toBe(small.id);
  const admitted = await runtime.submit({ type: 'input', content: 'Check the selected model' });
  expect((await runtime.answer(admitted.id)).text).toBe('Selected model answered');
  expect(payloads[0]?.model).toBe(small.id);
  expect(payloads[0]?.max_tokens ?? payloads[0]?.max_completion_tokens).toBeLessThanOrEqual(4096);
  const host = await serve(runtime, { port: 0 }); cleanup.push(() => host.close());
  expect(await (await fetch(`${host.url}/v1/models`)).json()).toMatchObject({ data: [{ id: small.id, context_window: 32768, modalities: ['text'] }] });
  const gateway = await fetch(`${host.url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: small.id, messages: [{ role: 'user', content: 'Use the current model' }] }) });
  expect(gateway.status).toBe(200); expect((await gateway.json()).model).toBe(small.id); expect(payloads[1]?.model).toBe(small.id);
  await host.close();
  await controller.close(); await runtime.close();
  const reopened = await MorphessRuntime.open(config, { resume: false }); cleanup.push(() => reopened.close());
  expect((await reopened.root.agent(BACKGROUND_CONTEXT)).model?.modelId).toBe(small.id);
  expect((await reopened.modelProfile()).input).toEqual(['text']);
  expect((await reopened.contextBudget()).contextWindow).toBe(32768); expect(payloads).toHaveLength(2);
});

it('blocks a switch during active generation and allows it after the run finishes', async () => {
  let release: (() => void) | undefined;
  const { config } = await fixture((req, res) => {
    req.resume(); release = () => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ id: 'reply', choices: [{ index: 0, delta: { content: 'Finished' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); };
  });
  const runtime = await MorphessRuntime.open(config); cleanup.push(() => runtime.close());
  const submission = await runtime.submit({ type: 'input', content: 'Wait for the fixture' });
  await expect.poll(() => typeof release).toBe('function');
  try { await expect(runtime.selectModel(small)).rejects.toThrow('Stop active work'); }
  finally { release?.(); }
  await runtime.answer(submission.id); await runtime.root.waitForIdle(BACKGROUND_CONTEXT);
  await runtime.selectModel(small); expect((await runtime.modelProfile()).id).toBe(small.id);
});

it('keeps model selection independent between sessions and updates the watched header', async () => {
  const { config } = await fixture((_req, res) => json(res, { data: [] }));
  const runtime = await MorphessRuntime.open(config); cleanup.push(() => runtime.close());
  const controller = await TuiController.open(runtime); cleanup.push(() => controller.close());
  const other = await runtime.createConversation(); await controller.switchSession(other.id); await controller.setModel(small);
  expect((await runtime.modelProfile()).id).toBe(config.model.id);
  await controller.switchSession('root'); expect(controller.state.model).toBe(config.model.id);
  await controller.switchSession(other.id); expect(controller.state.model).toBe(small.id);
});

it('does not inherit model prices and blocks unknown prices under a spend limit', async () => {
  const { config } = await fixture((_req, res) => res.end());
  config.model.cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }; config.limits.maxSpendUsd = 10;
  expect(profileForChoice(config, small).cost).toBeUndefined();
  const runtime = await MorphessRuntime.open(config); cleanup.push(() => runtime.close());
  await expect(runtime.selectModel(small)).rejects.toThrow('explicit prices');
});
