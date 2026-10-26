import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectMcpServers, mcpToolName } from '../src/mcp/index.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixtureScript() {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-mcp-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.mjs');
  await writeFile(path, `
import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
import {appendFile} from 'node:fs/promises';
const server = new Server({name:'offline-fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[
 {name:'echo',description:'Echo a message from the local fixture',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false}},
 {name:'slow',description:'Wait before replying',inputSchema:{type:'object',properties:{},additionalProperties:false}}
]}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
 if(process.env.FIXTURE_CALLS) await appendFile(process.env.FIXTURE_CALLS,'called\\n');
 if(request.params.name==='slow') await new Promise(resolve=>setTimeout(resolve,1000));
 return {content:[{type:'text',text:request.params.name==='echo'?request.params.arguments.message+':'+process.env.FIXTURE_VALUE:'late'}]};
});
await server.connect(new StdioServerTransport());
process.stdin.on('end',()=>process.exit(0));
`);
  return path;
}

describe('native MCP integration', () => {
  it('connects stdio, discovers deferred tools, validates arguments, and returns model output', async () => {
    const fixture = await fixtureScript();
    const connected = await connectMcpServers([{
      transport: 'stdio', name: 'fixture', command: process.execPath, args: [fixture],
      env: { FIXTURE_VALUE: 'MORPHESS_FIXTURE_VALUE' }, timeoutMs: 5_000,
    }], { env: { MORPHESS_FIXTURE_VALUE: 'environment-reference' } });
    cleanup.push(connected.close);
    const tools = connected.extensions.flatMap(extension => extension.tools ?? []);
    expect(tools).toHaveLength(2);
    expect(tools.every(tool => tool.deferred && tool.replay === 'unsafe')).toBe(true);
    expect(JSON.stringify(connected.extensions)).not.toContain('environment-reference');
    const faux = fauxProvider();
    const name = mcpToolName('fixture', 'echo');
    let loaded = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('tool_search', { query: 'echo fixture' }), { stopReason: 'toolUse' }),
      request => {
        loaded = request.messages.some(message => message.role === 'system' && message.toolsAdded?.some(tool => tool.name === name));
        return fauxAssistantMessage(fauxToolCall(name, { message: 'hello' }), { stopReason: 'toolUse' });
      },
      fauxAssistantMessage(fauxToolCall(name, { message: { invalid: true } }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('done'),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const registry = createRegistry(); registry.install(createToolSearchExtension());
    for (const extension of connected.extensions) registry.install(extension);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    cleanup.push(() => harness.close(context));
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
    expect((await (await root.submit({ type: 'input', content: 'echo hello with the fixture' }, context)).wait(context)).status).toBe('done');
    const messages = (await root.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
    expect(loaded).toBe(true);
    expect(JSON.stringify(messages)).toContain('hello:environment-reference');
    const failures = messages.filter(message => message.role === 'toolResult' && message.isError);
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).toContain('Validation failed');
    await connected.close(); await connected.close();
    await expect(tools[0]!.execute({ message: 'closed' }, {} as ToolExecutionApi, context)).rejects.toThrow('closed');
  });

  it('times out calls and forwards invocation cancellation', async () => {
    const fixture = await fixtureScript();
    const connected = await connectMcpServers([{
      transport: 'stdio', name: 'fixture', command: process.execPath, args: [fixture], env: {}, timeoutMs: 500,
    }]);
    cleanup.push(connected.close);
    const slow = connected.extensions[0]!.tools!.find(tool => tool.name === mcpToolName('fixture', 'slow'))!;
    await expect(slow.execute({}, {} as ToolExecutionApi, context)).rejects.toThrow();
    const controller = new AbortController();
    const pending = slow.execute({}, {} as ToolExecutionApi, withAbortSignal(controller.signal, context));
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
  });

  it('resolves HTTP auth references and closes streamable HTTP sessions', async () => {
    const mcp = new Server({ name: 'http-fixture', version: '1' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'answer', inputSchema: { type: 'object' } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'local-http' }] }));
    await mcp.connect(transport);
    let authorized = false;
    let deletedSessions = 0;
    const http = createServer((request, response) => {
      authorized ||= request.headers.authorization === 'fixture-auth-reference';
      if (request.method === 'DELETE' && request.headers['mcp-session-id']) deletedSessions++;
      void transport.handleRequest(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    cleanup.push(async () => { await mcp.close(); http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); });
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('No local port');
    const connected = await connectMcpServers([{
      transport: 'http', name: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'MCP_FIXTURE_AUTH' }, timeoutMs: 3_000,
    }], { env: { MCP_FIXTURE_AUTH: 'fixture-auth-reference' } });
    cleanup.push(connected.close);
    const output = await connected.extensions[0]!.tools![0]!.execute({}, {} as ToolExecutionApi, context);
    expect(output.output).toEqual([{ type: 'text', text: 'local-http' }]);
    expect(authorized).toBe(true);
    await connected.close(); await connected.close();
    expect(deletedSessions).toBe(1);
  });

  it('rolls back earlier transports when a later server cannot initialize', async () => {
    const fixture = await fixtureScript();
    await expect(connectMcpServers([
      { transport: 'stdio', name: 'one', command: process.execPath, args: [fixture], env: {}, timeoutMs: 3_000 },
      { transport: 'stdio', name: 'two', command: '/does/not/exist/morphess-fixture', args: [], env: {}, timeoutMs: 500 },
    ])).rejects.toThrow();
  });

  it('rejects missing secret references and produces stable collision-resistant names', async () => {
    await expect(connectMcpServers([{
      transport: 'http', name: 'private', url: 'http://127.0.0.1:1', headers: { Authorization: 'MISSING' }, timeoutMs: 100,
    }], { env: {} })).rejects.toThrow('environment variable MISSING');
    expect(mcpToolName('a.b', 'c')).not.toBe(mcpToolName('a_b', 'c'));
    expect(mcpToolName('x'.repeat(100), 'y'.repeat(100))).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('never replays an interrupted external side effect when reopening durable storage', async () => {
    const fixture = await fixtureScript();
    const callsPath = join(dirname(fixture), 'calls');
    const database = join(dirname(fixture), 'state.sqlite');
    const config = { transport: 'stdio' as const, name: 'effects', command: process.execPath, args: [fixture], env: { FIXTURE_CALLS: 'MORPHESS_MCP_CALLS' }, timeoutMs: 5_000 };
    const env = { MORPHESS_MCP_CALLS: callsPath };
    let connected = await connectMcpServers([config], { env });
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('tool_search', { query: 'slow effects' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall(mcpToolName('effects', 'slow'), {}), { stopReason: 'toolUse' }),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const registry = createRegistry(); registry.install(createToolSearchExtension());
    for (const extension of connected.extensions) registry.install(extension);
    let harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
    try {
      const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
      const submission = await root.submit({ type: 'input', content: 'execute once' }, context);
      await expect.poll(() => readFile(callsPath, 'utf8').catch(() => ''), { interval: 10 }).toBe('called\n');
      await harness.close(context);
      await connected.close();
      connected = await connectMcpServers([config], { env });
      for (const extension of connected.extensions) registry.install(extension);
      faux.setResponses([fauxAssistantMessage('external operation interrupted; inspect before retrying')]);
      harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
      const recovered = await harness.submission(submission.id, context);
      expect((await recovered!.wait(context)).status).toBe('done');
      const reopenedRoot = await harness.root(context);
      const messages = (await reopenedRoot.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
      const interrupted = messages.filter(message => message.role === 'toolResult' && message.isError);
      expect(interrupted).toHaveLength(1);
      expect(JSON.stringify(interrupted)).toContain('interrupted');
      expect(await readFile(callsPath, 'utf8')).toBe('called\n');
    } finally { await harness.close(context); await connected.close(); }
  });
});
