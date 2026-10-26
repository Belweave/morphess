import type { MorphessConfig } from '../config.js';
import { readProviderCredential, canonicalProviderEndpoint } from './credentials.js';

export interface ModelChoice {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  input?: Array<'text' | 'image'>;
  reasoning?: boolean;
  source: 'configured' | 'provider' | 'manual';
}
export function validateModelId(id: string): string {
  if (!id.trim() || id !== id.trim() || id.length > 256 || /[\x00-\x20\x7f-\x9f]/u.test(id)) throw new Error('Enter a model ID of 1–256 characters without spaces or control characters');
  return id;
}
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (...values: unknown[]): number | undefined => values.find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) as number | undefined;

/** Parse only explicit metadata; an OpenAI ID-only roster does not establish capacity. */
export function parseModelList(payload: unknown): ModelChoice[] {
  const data = record(payload).data;
  if (!Array.isArray(data) || data.length > 10_000) throw new Error('Model endpoint must return an OpenAI data array with at most 10,000 models');
  const choices = new Map<string, ModelChoice>();
  for (const value of data) {
    const item = record(value);
    if (typeof item.id !== 'string') continue;
    try { validateModelId(item.id); } catch { continue; }
    const modalities = Array.isArray(item.input_modalities) ? item.input_modalities : record(item.architecture).input_modalities;
    const types = Array.isArray(modalities) ? modalities.map(value => typeof value === 'string' ? value : record(value).type) : undefined;
    // Embedding, audio-only, and image-generation models cannot run the coding loop.
    if (types && !types.includes('text')) continue;
    const text = Array.isArray(modalities) ? record(modalities.find(value => record(value).type === 'text')) : {};
    const output = Array.isArray(item.output_modalities) ? record(item.output_modalities.find(value => record(value).type === 'text')) : {};
    if (Array.isArray(item.output_modalities) && !item.output_modalities.some(value => value === 'text' || record(value).type === 'text')) continue;
    const contextWindow = positive(item.context_window, item.context_length, item.max_model_len, record(record(text.supported_inputs).max_context_length).value);
    const maxOutputTokens = positive(item.max_output_tokens, item.max_completion_tokens, record(item.top_provider).max_completion_tokens, record(output.max_length).value);
    choices.set(item.id, {
      id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 256) : item.id, source: 'provider',
      ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(types ? { input: types.includes('image') ? ['text', 'image'] : ['text'] } : {}),
      ...(typeof item.reasoning === 'boolean' ? { reasoning: item.reasoning } : {}),
    });
  }
  return [...choices.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

async function readModelResponse(response: Response): Promise<ModelChoice[]> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Model endpoint returned an empty response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4 * 1024 * 1024) throw new Error('Model catalog exceeds 4 MiB'); chunks.push(next.value); }
    try { return parseModelList(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('Model endpoint returned invalid JSON'); throw error; }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** The authenticated roster owns availability; metadata may only enrich matching IDs. */
export function enrichModelList(roster: ModelChoice[], metadata: ModelChoice[]): ModelChoice[] {
  const byId = new Map(metadata.map(model => [model.id, model]));
  return roster.map(model => ({ ...byId.get(model.id), ...model,
    name: model.name === model.id ? byId.get(model.id)?.name ?? model.name : model.name,
  }));
}

/** Authenticated, bounded GET against the configured origin only; never follow credential redirects. */
export async function discoverModels(profile: MorphessConfig['model'], options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<ModelChoice[]> {
  const env = options.env ?? process.env;
  const endpoint = new URL(canonicalProviderEndpoint(profile.baseUrl));
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/models`;
  const key = env[profile.apiKeyEnv] || await readProviderCredential(profile.baseUrl, env);
  if (!key && !profile.allowUnauthenticated) throw new Error(`No provider key. Run morphess auth login or set ${profile.apiKeyEnv}`);
  const signal = AbortSignal.any([AbortSignal.timeout(Math.min(profile.timeoutMs, 15_000)), ...(options.signal ? [options.signal] : [])]);
  let response: Response;
  try { response = await fetch(endpoint, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: 'manual', signal }); }
  catch { signal.throwIfAborted(); throw new Error('Cannot reach the model endpoint; check the provider URL and connection'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Model discovery returned HTTP ${response.status}. ${response.status === 401 || response.status === 403 ? 'Check the provider key with morphess auth login.' : 'Use a manual model ID or check the provider URL.'}`);
  }
  const choices = await readModelResponse(response);
  if (endpoint.origin === 'https://api.morphllm.com' && endpoint.pathname === '/v1/models') {
    // Morph's authenticated roster is ID-only. Its official public metadata
    // supplies capabilities; this separate request never receives the API key.
    try {
      const metadata = await fetch('https://www.morphllm.com/api/models/json', { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]) });
      if (metadata.ok) return enrichModelList(choices, await readModelResponse(metadata));
      await metadata.body?.cancel();
    } catch { signal.throwIfAborted(); }
  }
  return choices;
}

/** Unknown fields retain the explicitly configured profile; the UI reviews these before selection. */
export function profileForChoice(config: MorphessConfig, choice: ModelChoice): MorphessConfig['model'] {
  const base = config.model;
  const contextWindow = choice.contextWindow ?? base.contextWindow;
  const maxOutputTokens = Math.min(choice.maxOutputTokens ?? base.maxOutputTokens, base.maxOutputTokens, Math.max(1, Math.floor(contextWindow / 4)));
  const profile = { ...base, id: validateModelId(choice.id), contextWindow, maxOutputTokens,
    input: choice.input ?? base.input, reasoning: choice.reasoning ?? base.reasoning,
  };
  // Prices for one ID must never silently become prices for another model.
  if (choice.id !== base.id) delete profile.cost;
  return profile;
}
