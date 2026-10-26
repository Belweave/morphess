import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { serve } from '../src/http/server.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(tokensPerSecond?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-review-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider({ ...(tokensPerSecond ? { tokensPerSecond, tokenSize: { min: 32, max: 32 } } : {}) });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await MorphessRuntime.open(defaultConfig(directory), { models, storage: new MemoryStorage() });
  cleanups.push(() => runtime.close());
  const server = await serve(runtime, { port: 0 });
  cleanups.push(() => server.close());
  return { faux, runtime, server };
}

it('does not rerun a standard stateless chat request after an idempotent retry', async () => {
  const { faux, runtime, server } = await setup();
  faux.setResponses([fauxAssistantMessage('first answer'), fauxAssistantMessage('second answer')]);
  const send = () => fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'same-external-request' },
    body: JSON.stringify({ model: runtime.config.model.id, messages: [{ role: 'user', content: 'Do the requested work once' }] }),
  });
  const first = await (await send()).json();
  const second = await (await send()).json();
  expect(second.conversation_id).toBe(first.conversation_id);
  expect(faux.state.callCount).toBe(1);
});

it('preserves output truncation in the OpenAI finish reason', async () => {
  const { faux, runtime, server } = await setup();
  faux.setResponses([fauxAssistantMessage('truncated answer', { stopReason: 'length' })]);
  const response = await fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: runtime.config.model.id, messages: [{ role: 'user', content: 'Continue until output cap' }] }),
  });
  const result = await response.json();
  expect(result.choices[0].finish_reason).toBe('length');
});

it('delivers the complete committed answer before the SSE terminal frame', async () => {
  const { faux, runtime, server } = await setup();
  const expected = 'abcdefghijklmnopqrstuvwxyz'.repeat(2_000);
  faux.setResponses([fauxAssistantMessage(expected)]);
  const response = await fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: runtime.config.model.id, stream: true, messages: [{ role: 'user', content: 'Produce the answer' }] }),
  });
  const frames = (await response.text()).split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => frame.slice(6));
  expect(frames.at(-1)).toBe('[DONE]');
  const content = frames.filter(frame => frame !== '[DONE]').flatMap(frame => {
    const event = JSON.parse(frame);
    return event.choices?.flatMap((choice: { delta: { content?: string } }) => choice.delta.content ?? []) ?? [];
  }).join('');
  expect(content).toBe(expected);
});

it('does not truncate a streamed answer while its listener is backpressured', async () => {
  const { faux, runtime, server } = await setup(1_000);
  // Model a consumer that pauses after the first content frame. Unlike socket
  // packet timing this makes the watcher lifecycle race deterministic.
  server.server.prependListener('request', (_request, response) => {
    const original = response.write.bind(response);
    let stalled = false;
    response.write = ((...args: Parameters<typeof response.write>) => {
      const result = original(...args);
      if (!stalled && String(args[0]).includes('"content"')) {
        stalled = true;
        setTimeout(() => response.emit('drain'), 350);
        return false;
      }
      return result;
    }) as typeof response.write;
  });
  const expected = 'abcdefghijklmnopqrstuvwxyz'.repeat(200);
  faux.setResponses([fauxAssistantMessage(expected)]);
  const response = await fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: runtime.config.model.id, stream: true, messages: [{ role: 'user', content: 'Produce the answer' }] }),
  });
  const content = (await response.text()).split('\n\n').filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]').map(frame => JSON.parse(frame.slice(6)))
    .flatMap(event => event.choices?.flatMap((choice: { delta: { content?: string } }) => choice.delta.content ?? []) ?? []).join('');
  expect(content.length).toBe(expected.length);
  expect(content).toBe(expected);
});
