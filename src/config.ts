import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Expected an environment variable name, never a secret value');
const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const endpoint = z.url().superRefine((value, ctx) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    ctx.addIssue({ code: 'custom', message: 'Use an HTTP(S) URL without embedded credentials' });
  }
});

const mcpFeatures = {
  protocol: z.enum(['auto', '2026-07-28', 'legacy']).default('auto'),
  elicitation: z.boolean().default(true), sampling: z.boolean().default(false),
  roots: z.array(z.string().min(1)).max(32).default([]),
  subscriptions: z.boolean().default(true), tasks: z.boolean().default(true),
  maxInputRounds: z.number().int().min(1).max(16).default(8),
};
export const mcpServerSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    ...mcpFeatures,
    transport: z.literal('stdio'), name: z.string().min(1), command: z.string().min(1),
    args: z.array(z.string()).default([]), env: z.record(z.string(), envName).default({}),
    cwd: z.string().min(1).optional(), timeoutMs: positiveInt.default(30_000),
  }),
  z.strictObject({
    ...mcpFeatures,
    transport: z.literal('http'), name: z.string().min(1), url: endpoint,
    headers: z.record(z.string(), envName).default({}), bearerTokenEnv: envName.optional(), timeoutMs: positiveInt.default(30_000),
    oauth: z.strictObject({
      issuer: endpoint, redirectUrl: endpoint,
      registration: z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('cimd'), clientMetadataUrl: endpoint }),
        z.strictObject({ type: z.literal('pre-registered'), clientId: z.string().min(1), clientSecretEnv: envName.optional() }),
        z.strictObject({ type: z.literal('dynamic') }),
      ]),
    }).optional(),
  }),
]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpServerInput = z.input<typeof mcpServerSchema>;

const modelSchema = z.strictObject({
  baseUrl: endpoint, id: z.string().min(1), api: z.enum(['chat-completions', 'responses']),
  apiKeyEnv: envName, contextWindow: positiveInt, maxOutputTokens: positiveInt,
  input: z.array(z.enum(['text', 'image'], { error: 'Pi OpenAI adapters support text and image input; audio, video, and documents require an explicit adapter' })).min(1),
  reasoning: z.boolean(), timeoutMs: positiveInt, idleTimeoutMs: positiveInt, maxRetries: z.number().int().min(0).max(10),
  allowUnauthenticated: z.boolean(),
  cost: z.strictObject({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative() }).optional(),
  compatibility: z.strictObject({
    supportsStore: z.boolean().optional(), supportsDeveloperRole: z.boolean().optional(),
    supportsLongCacheRetention: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(), supportsUsageInStreaming: z.boolean().optional(),
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  }).optional(),
});

export const morphessConfigSchema = z.strictObject({
  workspace: z.string().min(1), stateDir: z.string().min(1), model: modelSchema,
  policy: z.strictObject({ mode: z.enum(['read-only', 'workspace-write', 'trusted']), shellTimeoutMs: positiveInt, maxOutputBytes: positiveInt }),
  limits: z.strictObject({ maxTurns: positiveInt, maxConcurrentAgents: positiveInt.max(16), maxAgentDepth: z.number().int().min(0).max(16), maxSpendUsd: z.number().positive().optional() }),
  server: z.strictObject({ host: z.string().min(1), port: z.number().int().min(0).max(65535), tokenEnv: envName }),
  plugins: z.array(z.string().min(1)), mcp: z.array(mcpServerSchema),
  context: z.strictObject({ reserveTokens: positiveInt, keepRecentTokens: positiveInt, cacheRetention: z.enum(['none', 'short', 'long']).default('short') }), codemode: z.boolean(),
}).superRefine((config, ctx) => {
  if (config.model.maxOutputTokens >= config.model.contextWindow) {
    ctx.addIssue({ code: 'custom', path: ['model', 'maxOutputTokens'], message: 'maxOutputTokens must be smaller than contextWindow' });
  }
  const reserve = Math.max(config.context.reserveTokens, config.model.maxOutputTokens);
  if (reserve + config.context.keepRecentTokens >= config.model.contextWindow) {
    ctx.addIssue({ code: 'custom', path: ['context'], message: 'Output reserve plus recent history must fit inside contextWindow' });
  }
  if (!config.model.input.includes('text')) {
    ctx.addIssue({ code: 'custom', path: ['model', 'input'], message: 'Coding harnesses require text input' });
  }
  if (new Set(config.model.input).size !== config.model.input.length) {
    ctx.addIssue({ code: 'custom', path: ['model', 'input'], message: 'Input modalities must be unique' });
  }
  if (config.model.api === 'responses' && config.model.compatibility) {
    const unsupported = Object.keys(config.model.compatibility).filter(key => !['supportsDeveloperRole', 'supportsLongCacheRetention'].includes(key));
    if (unsupported.length) ctx.addIssue({ code: 'custom', path: ['model', 'compatibility'], message: `Responses API does not support these Chat Completions compatibility options: ${unsupported.join(', ')}` });
  }
  if (new Set(config.mcp.map(server => server.name)).size !== config.mcp.length) {
    ctx.addIssue({ code: 'custom', path: ['mcp'], message: 'MCP server names must be unique' });
  }
  if (config.limits.maxSpendUsd !== undefined && !config.model.cost) {
    ctx.addIssue({ code: 'custom', path: ['model', 'cost'], message: 'Spend limits require explicit per-million-token model prices; unknown prices are not free' });
  }
});
export type MorphessConfig = z.infer<typeof morphessConfigSchema>;

export function defaultConfig(workspace: string): MorphessConfig {
  return {
    workspace: resolve(workspace), stateDir: resolve(workspace, '.morphess'),
    model: { baseUrl: 'https://api.morphllm.com/v1', id: 'morph-kimik3', api: 'chat-completions', apiKeyEnv: 'MORPH_API_KEY', contextWindow: 1_000_000, maxOutputTokens: 32_768, input: ['text', 'image'], reasoning: false, timeoutMs: 600_000, idleTimeoutMs: 120_000, maxRetries: 0, allowUnauthenticated: false },
    policy: { mode: 'workspace-write', shellTimeoutMs: 120_000, maxOutputBytes: 65_536 },
    limits: { maxTurns: 100, maxConcurrentAgents: 3, maxAgentDepth: 1 },
    server: { host: '127.0.0.1', port: 8787, tokenEnv: 'MORPHESS_SERVER_TOKEN' },
    plugins: [], mcp: [], context: { reserveTokens: 65_536, keepRecentTokens: 131_072, cacheRetention: 'short' }, codemode: true,
  };
}

/** Read only the named config or cwd/morphess.json. Relative paths resolve against the config file. */
export async function loadConfig(options: { cwd?: string; path?: string; env?: NodeJS.ProcessEnv } = {}): Promise<MorphessConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.path ?? 'morphess.json');
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    raw = z.record(z.string(), z.unknown()).parse(parsed);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT' && !options.path)) throw error;
  }
  const base = defaultConfig(cwd);
  const merged: Record<string, unknown> = { ...base, ...raw };
  for (const key of ['model', 'policy', 'limits', 'server', 'context'] as const) {
    if (raw[key] !== undefined) merged[key] = { ...base[key], ...z.record(z.string(), z.unknown()).parse(raw[key]) };
  }
  const env = options.env ?? process.env;
  const model = merged.model as Record<string, unknown>;
  for (const [variable, field] of [['MORPHESS_BASE_URL', 'baseUrl'], ['MORPHESS_MODEL', 'id'], ['MORPHESS_API', 'api'], ['MORPHESS_API_KEY_ENV', 'apiKeyEnv']] as const) {
    if (env[variable] !== undefined) model[field] = env[variable];
  }
  const config = morphessConfigSchema.parse(merged);
  config.workspace = resolve(dirname(configPath), config.workspace);
  // An unspecified state directory follows an explicitly configured workspace.
  config.stateDir = raw.stateDir === undefined ? resolve(config.workspace, '.morphess') : resolve(dirname(configPath), config.stateDir);
  for (const server of config.mcp) {
    if (server.transport === 'stdio' && server.cwd !== undefined) server.cwd = resolve(dirname(configPath), server.cwd);
    server.roots = server.roots.map(root => root.startsWith('file:') ? root : resolve(dirname(configPath), root));
  }
  return config;
}
