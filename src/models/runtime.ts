import {
  createModels, createProvider, lazyStream,
  type Api, type AssistantMessage, type Model, type Models, type ProviderStreams, type StreamOptions, type TranscriptContext,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { raceWithAbortSignal } from '@earendil-works/pi-ai/utils/abort';
import type { MorphessConfig } from '../config.js';
import { readProviderCredential } from './credentials.js';

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
    if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) throw new Error('maxTokens must be a positive safe integer');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('timeoutMs must be a positive safe integer');
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
        // Tool declarations are a set. Canonicalize only the request catalog, never
        // transcript messages or tool-call/result order (Pi owns their semantics).
        if (Array.isArray(body.tools)) {
          const name = (tool: unknown): string => {
            if (typeof tool !== 'object' || tool === null) return '';
            const declaration = tool as Record<string, unknown>;
            const fn = declaration.function;
            return typeof declaration.name === 'string' ? declaration.name
              : typeof fn === 'object' && fn !== null && 'name' in fn && typeof fn.name === 'string' ? fn.name : '';
          };
          body.tools = [...body.tools].sort((left, right) => {
            const a = name(left); const b = name(right);
            return a < b ? -1 : a > b ? 1 : 0;
          });
        }
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
      try {
        while (true) {
          // A shared unresolved abort Promise retains a reaction for every stream
          // event. Pi's helper removes its listener after each wait instead.
          const next = await raceWithAbortSignal(iterator.next(), controller.signal);
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
      ? { compat: { supportsStore: false, supportsLongCacheRetention: false, ...profile.compatibility } }
      : { compat: { supportsDeveloperRole: profile.compatibility?.supportsDeveloperRole, supportsLongCacheRetention: profile.compatibility?.supportsLongCacheRetention ?? false } }),
  };
  const adapter = api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi();
  const provider = createProvider({
    id: MORPHESS_PROVIDER, name: 'Morphess OpenAI-compatible', baseUrl: profile.baseUrl, models: [model],
    auth: { apiKey: {
      name: profile.apiKeyEnv,
      resolve: async ({ signal }) => {
        signal.throwIfAborted();
        const environmentKey = env[profile.apiKeyEnv];
        const key = environmentKey || await readProviderCredential(profile.baseUrl, env);
        signal.throwIfAborted();
        if (key) return { auth: { apiKey: key }, source: environmentKey ? profile.apiKeyEnv : 'private provider credential store' };
        if (profile.allowUnauthenticated) return { auth: { apiKey: 'morphess-unauthenticated' }, source: 'explicit unauthenticated endpoint' };
        throw new Error(`Missing ${profile.apiKeyEnv}; set it in the environment, run morphess auth login, or explicitly enable model.allowUnauthenticated for a keyless endpoint`);
      },
    } },
    api: boundedAdapter(adapter, profile),
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model: { provider: MORPHESS_PROVIDER, modelId: profile.id } };
}
