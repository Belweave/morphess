import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { serve } from '../src/http/server.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(options: { token?: string; maxEventStreams?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-http-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = await MorphessRuntime.open(defaultConfig(directory), { models, storage: new MemoryStorage() }); cleanup.push(() => runtime.close());
  const server = await serve(runtime, { ...options, port: 0 }); cleanup.push(() => server.close());
  return { runtime, server, faux };
}

it('protects authenticated routes, rejects browser origins and remote binding without a token', async () => {
  const { runtime, server } = await setup({ token: 'server-test-token' });
  expect((await fetch(`${server.url}/health`)).status).toBe(200);
  expect((await fetch(`${server.url}/v1/models`)).status).toBe(401);
  expect((await fetch(`${server.url}/v1/models`, { headers: { authorization: 'Bearer server-test-token' } })).status).toBe(200);
  expect((await fetch(`${server.url}/v1/models`, { headers: { origin: 'https://evil.test', authorization: 'Bearer server-test-token' } })).status).toBe(403);
  await expect(serve(runtime, { host: '0.0.0.0', port: 0 })).rejects.toThrow('bearer token');
});

it('admits durable inputs, reacquires answers, and returns paginated history and context budgets', async () => {
  const { faux, server } = await setup(); faux.setResponses([fauxAssistantMessage('answer')]);
  const send = () => fetch(`${server.url}/v1/sessions/root/inputs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello', requestId: 'native-once' }) });
  const receipt = await (await send()).json();
  const answer = await (await fetch(`${server.url}/v1/submissions/${receipt.id}?wait=true`)).json();
  expect(answer.text).toBe('answer');
  expect((await (await send()).json()).id).toBe(receipt.id);
  const history = await (await fetch(`${server.url}/v1/sessions/root/entries?limit=1`)).json();
  expect(history.items).toHaveLength(1); expect(history.next).toBeTypeOf('string');
  const next = await (await fetch(`${server.url}/v1/sessions/root/entries?limit=1&cursor=${history.next}`)).json();
  expect(next.items[0].id).not.toBe(history.items[0].id);
  const budget = await (await fetch(`${server.url}/v1/sessions/root/context`)).json();
  expect(budget.contextWindow).toBe(1_000_000);
});

it('rejects mismatched idempotency keys, unknown request fields, and remote image fetching', async () => {
  const { runtime, faux, server } = await setup(); faux.setResponses([fauxAssistantMessage('once')]);
  const send = (content: unknown, headers: Record<string, string> = {}) => fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: runtime.config.model.id, ...content as object }) });
  expect((await send({ messages: [{ role: 'user', content: 'one' }] }, { 'idempotency-key': 'key' })).status).toBe(200);
  expect((await send({ messages: [{ role: 'user', content: 'two' }] }, { 'idempotency-key': 'key' })).status).toBe(409);
  expect((await send({ tools: [], messages: [{ role: 'user', content: 'one' }] })).status).toBe(400);
  expect((await send({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data' } }] }] })).status).toBe(400);
});

it('reserves stream admission before asynchronous work, including concurrent chat requests', async () => {
  const { runtime, faux, server } = await setup({ maxEventStreams: 1 });
  faux.setResponses([async () => { await new Promise(resolve => setTimeout(resolve, 100)); return fauxAssistantMessage('one'); }]);
  const send = () => fetch(`${server.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: runtime.config.model.id, stream: true, messages: [{ role: 'user', content: 'work' }] }) });
  const responses = await Promise.all([send(), send()]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 429]);
  await Promise.all(responses.map(response => response.text()));
});
