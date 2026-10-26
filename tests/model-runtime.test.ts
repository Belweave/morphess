import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Type, type AssistantMessageEvent, type Context } from '@earendil-works/pi-ai';
import { defaultConfig } from '../src/config.js';
import { createModelRuntime } from '../src/models/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(handler: (body: Record<string, unknown>, response: ServerResponse, request: IncomingMessage) => void) {
  const requests: { body: Record<string, unknown>; path: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push({ body, path: request.url, authorization: request.headers.authorization });
    handler(body, response, request);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const config = defaultConfig(process.cwd());
  config.model.apiKeyEnv = 'MORPHESS_API_KEY';
  config.model.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  config.model.id = 'custom-million-vision-model';
  return { config, requests };
}

const context: Context = {
  systemPrompt: 'You are a coding assistant.',
  messages: [{ role: 'user', timestamp: 1, content: [{ type: 'text', text: 'Inspect this image.' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] }],
  tools: [{ name: 'read_file', description: 'Read a file', parameters: Type.Object({ path: Type.String() }) }],
};

function sse(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

describe('custom OpenAI-compatible streaming through real Pi adapters', () => {
  it('streams Chat Completions tools, transmits images and caps output after sampling overrides', async () => {
    const { config, requests } = await fixture((_body, response) => sse(response, [
      { id: 'chat_1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { id: 'chat_1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"src/index.ts"}' } }] } }] },
      { id: 'chat_1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    ]));
    const { models, model: ref } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture-key' });
    const model = models.getModel(ref.provider, ref.modelId)!;
    expect(model.contextWindow).toBe(1_000_000);
    const stream = models.streamSimple(model, context, {
      samplingParams: { max_completion_tokens: 999_999 },
      onPayload: payload => ({ ...payload as Record<string, unknown>, max_completion_tokens: null }),
    });
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe('toolUse');
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'toolCall', name: 'read_file', arguments: { path: 'src/index.ts' } }));
    expect(events.some(event => event.type === 'toolcall_delta')).toBe(true);
    expect(requests[0]?.path).toBe('/v1/chat/completions');
    expect(requests[0]?.authorization).toBe('Bearer fixture-key');
    expect(requests[0]?.body.max_completion_tokens).toBe(32_768);
    expect(JSON.stringify(requests[0]?.body.messages)).toContain('data:image/png;base64,aW1hZ2U=');
    expect(result.usage.totalTokens).toBe(120);
  });

  it('uses Responses API with custom model, image input and streamed tool arguments', async () => {
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' };
    const { config, requests } = await fixture((_body, response) => sse(response, [
      { type: 'response.output_item.added', sequence_number: 0, output_index: 0, item },
      { type: 'response.function_call_arguments.delta', sequence_number: 1, item_id: 'fc_1', output_index: 0, delta: '{"path":"README.md"}' },
      { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: { ...item, arguments: '{"path":"README.md"}' } },
      { type: 'response.completed', sequence_number: 3, response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    ]));
    config.model.api = 'responses';
    const { models, model: ref } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture-key' });
    const result = await models.completeSimple(models.getModel(ref.provider, ref.modelId)!, context);
    expect(result.stopReason).toBe('toolUse');
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'toolCall', name: 'read_file', arguments: { path: 'README.md' } }));
    expect(requests[0]?.path).toBe('/v1/responses');
    expect(requests[0]?.body.max_output_tokens).toBe(32_768);
    expect(JSON.stringify(requests[0]?.body.input)).toContain('data:image/png;base64,aW1hZ2U=');
  });

  it('rejects undeclared image support before sending a request', async () => {
    const { config, requests } = await fixture(() => { throw new Error('Must not reach HTTP'); });
    config.model.input = ['text'];
    const { models, model } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture-key' });
    const result = await models.completeSimple(models.getModel(model.provider, model.modelId)!, context);
    expect(result.errorMessage).toContain('does not declare image');
    expect(requests).toHaveLength(0);
  });

  it('requires explicit authentication configuration', async () => {
    const { config, requests } = await fixture(() => { throw new Error('Must not reach HTTP'); });
    const { models, model } = createModelRuntime(config, {});
    const result = await models.completeSimple(models.getModel(model.provider, model.modelId)!, context);
    expect(result.errorMessage).toContain('Missing MORPHESS_API_KEY');
    expect(requests).toHaveLength(0);
  });

  it('returns endpoint errors without hidden retries', async () => {
    const { config, requests } = await fixture((_body, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture unavailable', type: 'server_error' } }));
    });
    const { models, model } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture-key' });
    const result = await models.completeSimple(models.getModel(model.provider, model.modelId)!, context);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('fixture unavailable');
    expect(requests).toHaveLength(1);
  });

  it('bounds idle streams and cancels transport', async () => {
    const { config } = await fixture((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
    });
    config.model.idleTimeoutMs = 40;
    const { models, model } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture-key' });
    const result = await models.completeSimple(models.getModel(model.provider, model.modelId)!, context);
    expect(result.errorMessage).toContain('idle timeout');
  });

  it('bounds a continuously active stream by its hard deadline', async () => {
    const { config } = await fixture((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const timer = setInterval(() => response.write(`data: ${JSON.stringify({ id: 'chat_slow', choices: [{ index: 0, delta: { content: 'x' } }] })}\n\n`), 10);
      response.on('close', () => clearInterval(timer));
    });
    config.model.timeoutMs = 80;
    config.model.idleTimeoutMs = 1000;
    const { models, model } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture-key' });
    const result = await models.completeSimple(models.getModel(model.provider, model.modelId)!, context);
    expect(result.errorMessage).toContain('hard timeout');
  });

  it('preserves caller cancellation as an aborted stream', async () => {
    const { config } = await fixture((_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
    });
    const controller = new AbortController();
    const { models, model } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture-key' });
    const result = models.completeSimple(models.getModel(model.provider, model.modelId)!, context, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('User cancelled request')), 40);
    expect((await result).stopReason).toBe('aborted');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])('rejects invalid output ceilings (%s) without dispatch', async maxTokens => {
    const { config, requests } = await fixture(() => { throw new Error('Must not reach HTTP'); });
    const { models, model } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture-key' });
    const result = await models.completeSimple(models.getModel(model.provider, model.modelId)!, context, { maxTokens });
    expect(result.errorMessage).toContain('maxTokens must be a positive safe integer');
    expect(requests).toHaveLength(0);
  });
});
