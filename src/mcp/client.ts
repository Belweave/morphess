import { createHash } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { mcpServerSchema, type McpServerConfig } from '../config.js';

export type { McpServerConfig } from '../config.js';

/** Stable OpenAI-compatible tool names, collision-resistant even after sanitizing/truncating. */
export function mcpToolName(server: string, tool: string): string {
  const readable = `${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 42);
  const digest = createHash('sha256').update(JSON.stringify([server, tool])).digest('hex').slice(0, 12);
  return `mcp_${readable}_${digest}`;
}

function environmentReferences(references: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, reference] of Object.entries(references)) {
    const value = env[reference];
    if (value === undefined) throw new Error(`MCP requires environment variable ${reference}`);
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Connected MCP tool catalogs become native Pi extensions, deferred until tool_search loads them.
 * All external calls are replay UNSAFE regardless of server-provided readOnly/idempotent annotations.
 * Secrets resolve from environment references and live only in transport memory, never extensions.
 * Configured stdio servers and HTTP endpoints are trusted executable integrations.
 * Catalog is a connection-time snapshot; reconnect the runtime to refresh changed tools.
 */
export async function connectMcpServers(configs: McpServerConfig[], options: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ extensions: Extension[]; close(): Promise<void> }> {
  const extensions: Extension[] = [];
  const connections: Array<{ client: Client; transport: Transport; timeoutMs: number }> = [];
  const names = new Set<string>();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const connection of connections.reverse()) {
      if (connection.transport instanceof StreamableHTTPClientTransport) {
        const transport = connection.transport;
        // SDK close() only aborts local streams. Explicit DELETE releases a stateful
        // server session; abort the transport if that request stalls during shutdown.
        const deadline = setTimeout(() => { void transport.close().catch(() => {}); }, Math.min(connection.timeoutMs, 5_000));
        deadline.unref();
        try { await transport.terminateSession(); } catch (error) { errors.push(error); }
        finally { clearTimeout(deadline); }
      }
      try { await connection.client.close(); } catch (error) { errors.push(error); }
      // Failed initialize may not have attached the transport to the client yet.
      try { await connection.transport.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'MCP cleanup failed');
  };
  try {
    // Connect sequentially to bound process/network pressure and make rollback deterministic.
    for (const raw of configs) {
      const config = mcpServerSchema.parse(raw);
      if (names.has(config.name)) throw new Error(`Duplicate MCP server: ${config.name}`);
      names.add(config.name);
      const env = options.env ?? process.env;
      let transport: Transport;
      if (config.transport === 'stdio') {
        transport = new StdioClientTransport({
          command: config.command, args: config.args, cwd: config.cwd,
          env: { ...getDefaultEnvironment(), ...environmentReferences(config.env, env) },
          // Untrusted server stderr can contain credentials; do not mirror it into a session or logs.
          stderr: 'ignore', maxBufferSize: 16 * 1024 * 1024,
        });
      } else {
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: environmentReferences(config.headers, env), redirect: 'error' },
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        });
      }
      const client = new Client({ name: 'morphess', version: '0.1.0' }, { capabilities: {} });
      connections.push({ client, transport, timeoutMs: config.timeoutMs });
      const setupSignal = AbortSignal.timeout(config.timeoutMs);
      await client.connect(transport, { timeout: config.timeoutMs, signal: setupSignal });
      const catalog: Tool[] = [];
      let catalogBytes = 0;
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: config.timeoutMs, signal: setupSignal });
        catalogBytes += Buffer.byteLength(JSON.stringify(page.tools));
        if (catalogBytes > 8 * 1024 * 1024) throw new Error(`MCP server ${config.name} exceeds the 8 MiB tool catalog budget`);
        catalog.push(...page.tools);
        if (catalog.length > 10_000) throw new Error(`MCP server ${config.name} exceeds 10000 tools`);
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) throw new Error(`MCP server ${config.name} repeated a pagination cursor`);
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      const seenTools = new Set<string>();
      const tools = catalog.map(remote => {
        if (seenTools.has(remote.name)) throw new Error(`MCP server ${config.name} duplicated tool ${remote.name}`);
        seenTools.add(remote.name);
        if (JSON.stringify(remote.inputSchema).length > 256_000) throw new Error(`MCP tool schema too large: ${remote.name}`);
        return defineTool({
          name: mcpToolName(config.name, remote.name),
          description: `[MCP ${config.name}/${remote.name}] ${(remote.description ?? 'External tool.').slice(0, 8_192)}`,
          // Pi validates this JSON schema using its native TypeBox validation before execution.
          parameters: Type.Unsafe<Record<string, unknown>>(remote.inputSchema),
          replay: 'unsafe', deferred: true,
          outputLimits: { maxBytes: 65_536, maxLines: 2_000 },
          execute: async (args, _api, context): Promise<ToolExecutionResult> => {
            if (closed) throw new Error('MCP connection is closed');
            const timeout = AbortSignal.timeout(config.timeoutMs);
            const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
            const result = CallToolResultSchema.parse(await client.callTool({ name: remote.name, arguments: args }, CallToolResultSchema, {
              timeout: config.timeoutMs, maxTotalTimeout: config.timeoutMs, signal,
            }));
            const output: NonNullable<ToolExecutionResult['output']> = [];
            for (const item of result.content) {
              if (item.type === 'text') output.push({ type: 'text', text: item.text });
              else if (item.type === 'image' && item.data.length <= 12_000_000) {
                output.push({ type: 'image', data: item.data, mimeType: item.mimeType });
              } else if (item.type === 'resource' && 'text' in item.resource) {
                output.push({ type: 'text', text: item.resource.text });
              } else {
                // Resource URLs remain inert; never fetch them or write server content to disk automatically.
                output.push({ type: 'text', text: `[MCP content ${item.type} omitted; use a tool with text/image output]` });
              }
            }
            return { output, isError: result.isError === true };
          },
        });
      });
      extensions.push(defineExtension({ name: `morphess-mcp-${config.name}`, tools }));
    }
    return { extensions, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'MCP connection and rollback failed'); }
    throw error;
  }
}
