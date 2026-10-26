import {
  createModels, createProvider, lazyStream,
  type Api, type AssistantMessage, type Model, type Models, type ProviderStreams, type StreamOptions, type TranscriptContext,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import type { MorphessConfig } from '../config.js';

export const MORPHESS_PROVIDER = 'morphess';

/** Validate before dispatch: Pi adapters can otherwise omit unsupported image blocks. */
function validateInput(context: TranscriptContext, model: Model<Api>): void {
  for (const message of context.messages) {
    if (message.role !== 'user' && message.role !== 'toolResult') continue;
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'text' && block.type !== 'image') {
        throw new Error(`Unsupported multimodal input: ${(block as { type: string }).type}; the ${model.api} adapter supports text and images only`);
      }
      if (block.type === 'image' && !model.input.includes('image')) {
        throw new Error(`Model ${model.id} does not declare image input support`);
      }
    }
  }
}

/** Add resource bounds around Pi's adapters; Pi continues to own streaming and tool JSON parsing. */
function boundedAdapter(adapter: ProviderStreams, config: MorphessConfig['model']): ProviderStreams {
  const dispatch = (simple: boolean, model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}) => lazyStream(model, async () => {
    validateInput(context, model);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason ?? new Error('Model request aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const hardMs = Math.min(options.timeoutMs ?? config.timeoutMs, config.timeoutMs);
    const hard = setTimeout(() => controller.abort(new Error(`Model request exceeded hard timeout (${hardMs} ms)`)), hardMs);
    hard.unref();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const refreshIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new Error(`Model stream exceeded idle timeout (${config.idleTimeoutMs} ms)`)), config.idleTimeoutMs);
      idle.unref();
    };
    refreshIdle();
    const merged: StreamOptions = {
      ...options,
      signal: controller.signal, timeoutMs: hardMs,
      maxTokens: Math.min(options.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens),
      maxRetries: options.maxRetries ?? config.maxRetries,
      onPayload: async (payload, target) => {
        const replacement = await options.onPayload?.(payload, target);
        const source = replacement ?? payload;
        if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new Error('Model payload hook must return a JSON object');
        const body = source as Record<string, unknown>;
        const cap = Math.min(options.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens);
        // Sampling extensions and payload hooks cannot bypass the configured output ceiling.
        const original = payload as Record<string, unknown>;
        const primary = model.api === 'openai-responses' ? 'max_output_tokens'
          : 'max_tokens' in original ? 'max_tokens' : 'max_completion_tokens';
        for (const field of new Set([primary, ...['max_tokens', 'max_completion_tokens', 'max_output_tokens'].filter(key => key in body)])) {
          const value = body[field];
          body[field] = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, cap) : cap;
        }
        return body;
      },
    };
    const source = simple ? adapter.streamSimple(model, context, merged) : adapter.stream(model, context, merged);
    return (async function* () {
      const iterator = source[Symbol.asyncIterator]();
      let partial: AssistantMessage | undefined;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try {
        while (true) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next.done) break;
          refreshIdle();
          if ('partial' in next.value) partial = next.value.partial;
          yield next.value;
        }
      } catch (error) {
        const reason = options.signal?.aborted ? 'aborted' as const : 'error' as const;
        const message: AssistantMessage = {
          ...(partial ?? {
            role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
            timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          }),
          stopReason: reason, errorMessage: error instanceof Error ? error.message : String(error),
        };
        yield { type: 'error' as const, reason, error: message };
      } finally {
        clearTimeout(hard);
        clearTimeout(idle);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        options.signal?.removeEventListener('abort', abort);
      }
    })();
  });
  return {
    stream: (model, context, options) => dispatch(false, model, context, options),
    streamSimple: (model, context, options) => dispatch(true, model, context, options),
  };
}

/** Register any explicitly described OpenAI-compatible model without catalog discovery. */
export function createModelRuntime(config: MorphessConfig, env: NodeJS.ProcessEnv = process.env): { models: Models; model: { provider: string; modelId: string } } {
  const profile = config.model;
  if (profile.input.some(type => type !== 'text' && type !== 'image')) {
    throw new Error('OpenAI adapters support text and image input only; audio/video/documents require an explicit adapter');
  }
  const api = profile.api === 'responses' ? 'openai-responses' : 'openai-completions';
  const model: Model<typeof api> = {
    provider: MORPHESS_PROVIDER, id: profile.id, name: profile.id, api, baseUrl: profile.baseUrl,
    reasoning: profile.reasoning, contextWindow: profile.contextWindow, maxTokens: profile.maxOutputTokens,
    input: profile.input,
    // Pi requires numeric prices. Absent prices mean unknown, and config forbids spend limits without prices.
    cost: profile.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(api === 'openai-completions'
      ? { compat: { supportsStore: false, ...profile.compatibility } }
      : { compat: { supportsDeveloperRole: profile.compatibility?.supportsDeveloperRole } }),
  };
  const adapter = api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi();
  const provider = createProvider({
    id: MORPHESS_PROVIDER, name: 'Morphess OpenAI-compatible', baseUrl: profile.baseUrl, models: [model],
    auth: { apiKey: {
      name: profile.apiKeyEnv,
      resolve: async ({ signal }) => {
        signal.throwIfAborted();
        const key = env[profile.apiKeyEnv];
        if (key) return { auth: { apiKey: key }, source: profile.apiKeyEnv };
        if (profile.allowUnauthenticated) return { auth: { apiKey: 'morphess-unauthenticated' }, source: 'explicit unauthenticated endpoint' };
        throw new Error(`Missing ${profile.apiKeyEnv}; set it in the environment or explicitly enable model.allowUnauthenticated for a keyless endpoint`);
      },
    } },
    api: boundedAdapter(adapter, profile),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model: { provider: MORPHESS_PROVIDER, modelId: profile.id } };
}
