import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT, awaitWithContext, withAbortSignal } from '@earendil-works/chord/context';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { serve } from '../src/http/server.js';
import { listQuestions, QuestionsDoc, type UserQuestion } from '../src/interaction/index.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(options: { token?: string; maxEventStreams?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-http-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = await MorphessRuntime.open(defaultConfig(directory), { models, storage: new MemoryStorage() }); cleanup.push(() => runtime.close());
  const server = await serve(runtime, { ...options, port: 0 }); cleanup.push(() => server.close());
  return { runtime, server, faux };
}

async function pendingQuestion(runtime: MorphessRuntime): Promise<UserQuestion> {
  await listQuestions(runtime.harness, runtime.root.id, BACKGROUND_CONTEXT);
  const context = withAbortSignal(AbortSignal.timeout(5_000), BACKGROUND_CONTEXT);
  const watch = (await runtime.harness.watchDoc(QuestionsDoc, runtime.root.id, context))!;
  try {
    return await awaitWithContext(new Promise<UserQuestion>((resolve, reject) => {
      const inspect = (value: typeof watch.value) => {
        const question = Object.values(value?.questions ?? {}).find(question => question.status === 'pending');
        if (question) resolve(question);
      };
      watch.start(async value => { inspect(value); }); inspect(watch.value);
      void watch.closed.then(end => reject(new Error(`Question watch ended: ${end.reason}`)));
    }), context);
  } finally { await watch.stop(); }
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

it('keeps busy stream rejection as HTTP409 before sending SSE headers', async () => {
  const { runtime, faux, server } = await setup();
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  faux.setResponses([async () => { entered(); await gate; return fauxAssistantMessage('first'); }]);
  const existing = await runtime.submit({ type: 'input', content: 'ongoing work' });
  await started;
  try {
    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: runtime.config.model.id, conversation_id: runtime.root.id, stream: true, messages: [{ role: 'user', content: 'second request' }] }),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toBe('application/json');
  } finally { unblock(); await runtime.answer(existing.id); }
});

it('closes a backpressured event stream promptly and makes server close idempotent', async () => {
  const { server } = await setup();
  server.server.prependListener('request', (_request, response) => { response.write = (() => false) as typeof response.write; });
  const response = await fetch(`${server.url}/v1/sessions/root/events`);
  const startedAt = performance.now();
  const firstClose = server.close();
  expect(server.close()).toBe(firstClose);
  await firstClose;
  expect(performance.now() - startedAt).toBeLessThan(1_000);
  await response.body?.cancel().catch(() => {});
});

it('rejects JSON lookalike media types before admission', async () => {
  const { server, faux } = await setup();
  const response = await fetch(`${server.url}/v1/sessions/root/inputs`, {
    method: 'POST', headers: { 'content-type': 'application/jsonp' }, body: JSON.stringify({ content: 'work' }),
  });
  expect(response.status).toBe(415);
  expect(faux.state.callCount).toBe(0);
});

it('validates inline image containers, base64, dimensions and count before model admission', async () => {
  const { runtime, server, faux } = await setup();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTqkAAAAASUVORK5CYII=', 'base64');
  const oversized = Buffer.from(png); oversized.writeUInt32BE(20_000, 16);
  const send = (content: unknown) => fetch(`${server.url}/v1/sessions/root/inputs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
  });
  const image = (data: string) => ({ type: 'image', mimeType: 'image/png', data });
  for (const content of [[image('abc')], [image(Buffer.from('not a PNG').toString('base64'))], [image(oversized.toString('base64'))], Array.from({ length: 17 }, () => image(png.toString('base64')))]) {
    expect((await send(content)).status).toBe(400);
  }
  const invalidOpenAI = await fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: runtime.config.model.id, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${oversized.toString('base64')}` } }] }] }),
  });
  expect(invalidOpenAI.status).toBe(400);
  expect(faux.state.callCount).toBe(0);
  faux.setResponses([fauxAssistantMessage('image accepted')]);
  const accepted = await send([image(png.toString('base64'))]);
  expect(accepted.status).toBe(202);
  await runtime.answer((await accepted.json()).id);
});

it('answers a durable headless chat question through the native API while chat waits', async () => {
  const { runtime, server, faux } = await setup();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Which target should I use?', options: ['Preview', 'Production'] }), { stopReason: 'toolUse' }),
    transcript => {
      const result = transcript.messages.findLast(message => message.role === 'toolResult');
      const answer = result?.role === 'toolResult' ? result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : '';
      return fauxAssistantMessage(`Chosen: ${answer}`);
    },
  ]);
  const pending = pendingQuestion(runtime);
  const chat = fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: runtime.config.model.id, conversation_id: runtime.root.id, messages: [{ role: 'user', content: 'Ask for a target' }] }),
  });
  const question = await pending;
  const listing = await fetch(`${server.url}/v1/sessions/root/questions`);
  expect(listing.status).toBe(200);
  const { items } = await listing.json();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: question.id, conversationId: runtime.root.id, question: 'Which target should I use?', status: 'pending', options: ['Preview', 'Production'] });
  expect(items[0].answer).toBeUndefined();
  expect(items[0].input).toBeUndefined();
  expect(faux.state.callCount).toBe(1);
  const answer = (value: string) => fetch(`${server.url}/v1/sessions/root/questions/${question.id}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: value }),
  });
  expect((await answer('A local staging target')).status).toBe(200);
  expect((await answer('A local staging target')).status).toBe(200);
  expect((await answer('Production')).status).toBe(409);
  const completed = await chat;
  expect(completed.status).toBe(200);
  expect((await completed.json()).choices[0].message.content).toBe('Chosen: A local staging target');
  expect((await (await fetch(`${server.url}/v1/sessions/root/questions`)).json()).items).toEqual([]);
  expect(faux.state.callCount).toBe(2);
});

it('authenticates question routes and distinguishes invalid, missing and stale answers', async () => {
  const token = 'http-question-test-token';
  const { runtime, server, faux } = await setup({ token });
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const route = `${server.url}/v1/sessions/root/questions`;
  expect((await fetch(route)).status).toBe(401);
  expect((await fetch(`${route}/1/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"answer":"no"}' })).status).toBe(401);
  expect((await fetch(route, { headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403);
  expect((await fetch(`${server.url}/v1/sessions/999999/questions`, { headers })).status).toBe(404);
  const post = (id: string | number, answer: unknown) => fetch(`${route}/${id}/answer`, { method: 'POST', headers, body: JSON.stringify(answer) });
  expect((await post(1, { answer: ' ' })).status).toBe(400);
  expect((await post(1, { answer: 'x', extra: 'not accepted' })).status).toBe(400);
  expect((await post('bad-id', { answer: 'x' })).status).toBe(400);
  expect((await post(0, { answer: 'x' })).status).toBe(400);
  expect((await post(999999, { answer: 'x' })).status).toBe(404);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Still needed?' }), { stopReason: 'toolUse' })]);
  const pending = pendingQuestion(runtime);
  const submission = await runtime.submit({ type: 'input', content: 'Ask then cancel' });
  const question = await pending;
  await runtime.root.abort(BACKGROUND_CONTEXT);
  await runtime.answer(submission.id);
  const stale = await post(question.id, { answer: 'Too late' });
  expect(stale.status).toBe(409);
  expect(JSON.stringify(await stale.json())).not.toContain(token);
  expect(faux.state.callCount).toBe(1);
});
