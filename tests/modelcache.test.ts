import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { defaultConfig, morphessConfigSchema } from '../src/config.js';
import { createContextSettings } from '../src/context/budget.js';
import { createModelRuntime } from '../src/models/runtime.js';

it('configures native cache retention without accepting unknown modes', () => {
  const config = defaultConfig('/tmp/cache-test');
  config.model.apiKeyEnv = 'MORPHESS_API_KEY';
  expect(createContextSettings(config).stream?.cacheRetention).toBe('short');
  config.context.cacheRetention = 'none';
  expect(createContextSettings(config).stream?.cacheRetention).toBe('none');
  expect(morphessConfigSchema.safeParse({ ...config, context: { ...config.context, cacheRetention: 'forever' } }).success).toBe(false);
});

it('preserves repeated prefixes, canonicalizes catalogs and reports only fixture cache usage', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw) as Record<string, unknown>);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_tokens_details: { cached_tokens: 80 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
    const config = defaultConfig('/tmp/cache-test');
  config.model.apiKeyEnv = 'MORPHESS_API_KEY';
    config.model.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    config.model.compatibility = { supportsLongCacheRetention: true };
    const { models, model: ref } = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture' });
    const model = models.getModel(ref.provider, ref.modelId)!;
    const tools = ['zeta', 'alpha'].map(name => ({ name, description: name, parameters: Type.Object({}) }));
    for (const catalog of [tools, [...tools].reverse()]) {
      const result = await models.completeSimple(model, { systemPrompt: 'stable policy', tools: catalog, messages: [{ role: 'user', content: 'stable question', timestamp: Date.now() }] }, { sessionId: 'stable-conversation', cacheRetention: 'long' });
      expect(result.usage.cacheRead).toBe(80);
      expect(result.usage.input).toBe(20);
      expect(result.usage.cacheWrite).toBe(0);
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]?.messages).toEqual(requests[1]?.messages);
    expect(requests[0]?.tools).toEqual(requests[1]?.tools);
    expect(requests[0]?.prompt_cache_key).toBe('stable-conversation');
    expect(requests[0]?.prompt_cache_retention).toBe('24h');
    config.model.compatibility = { supportsLongCacheRetention: false };
    const disabled = createModelRuntime(config, { MORPHESS_API_KEY: 'fixture' });
    await disabled.models.completeSimple(disabled.models.getModel(ref.provider, ref.modelId)!, { messages: [{ role: 'user', content: 'test', timestamp: 1 }] }, { sessionId: 'stable-conversation', cacheRetention: 'long' });
    expect(requests[2]).not.toHaveProperty('prompt_cache_retention');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
