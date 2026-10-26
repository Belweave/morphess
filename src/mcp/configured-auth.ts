import { join } from 'node:path';
import type { AuthProvider } from '@modelcontextprotocol/client';
import { mcpServerSchema, type McpServerInput } from '../config.js';
import { createMcpOAuthSession } from './auth.js';
import { createMcpCredentialStore } from './credential-store.js';

/** Runtime reuse/refresh only. New grants and registrations require the explicit CLI login command. */
export async function createConfiguredMcpAuth(configs: readonly McpServerInput[], stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<{ authProviders: Record<string, AuthProvider>; close(): void }> {
  const authProviders: Record<string, AuthProvider> = {};
  const sessions: ReturnType<typeof createMcpOAuthSession>[] = [];
  const selected = configs.map(config => mcpServerSchema.parse(config)).filter(config => config.transport === 'http' && config.oauth);
  if (!selected.length) return { authProviders, close() {} };
  const credentialStore = await createMcpCredentialStore(join(stateDir, 'mcp-credentials'));
  try { for (const config of selected) {
    if (config.transport !== 'http' || !config.oauth) continue;
    const session = createMcpOAuthSession({
      serverUrl: config.url, ...config.oauth, credentialStore, interactive: false,
      timeoutMs: config.timeoutMs, env,
      onAuthorization: () => { throw new Error(`MCP ${config.name} requires login. Run morphess mcp login ${config.name}`); },
    });
    sessions.push(session); authProviders[config.name] = session.authProvider;
  } } catch (error) { for (const session of sessions) session.close(); throw error; }
  return { authProviders, close() { for (const session of sessions) session.close(); } };
}
