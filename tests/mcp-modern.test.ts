import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer, createMcpHandler, ResourceTemplate, inputRequired, acceptedContent, completable } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { BACKGROUND_CONTEXT as context, awaitWithContext, withAbortSignal } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createRegistry, Harness, MemoryStorage, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { connectMcpServers, mcpToolName } from '../src/mcp/index.js';
import { createQuestionsExtension, listQuestions, QuestionsDoc, answerQuestion, type UserQuestion } from '../src/interaction/index.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function modernFixture(factory: () => McpServer) {
  const requests: Array<{ headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const handler = createMcpHandler(factory);
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => { if (body) requests.push({ headers: request.headers, body: JSON.parse(body) as Record<string, unknown> }); });
    void nodeHandler(request, response);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { await handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  return { url: `http://127.0.0.1:${address.port}/mcp`, requests, handler };
}
async function pendingQuestion(harness: Harness, id: Parameters<typeof listQuestions>[1]): Promise<UserQuestion> {
  await listQuestions(harness, id, context);
  const waiting = withAbortSignal(AbortSignal.timeout(5_000), context);
  const watch = (await harness.watchDoc(QuestionsDoc, id, waiting))!;
  try {
    return await awaitWithContext(new Promise<UserQuestion>((resolve, reject) => {
      const inspect = (value: typeof watch.value) => { const question = Object.values(value?.questions ?? {}).find(item => item.status === 'pending'); if (question) resolve(question); };
      watch.start(async value => { inspect(value); }); inspect(watch.value);
      void watch.closed.then(end => reject(new Error(end.reason)));
    }), waiting);
  } finally { await watch.stop(); }
}

describe('MCP2026-07-28 official SDK interoperability', () => {
  it('negotiates stateless HTTP, mirrors routing headers, caches lists, exposes resources/prompts/completions, and receives changes', async () => {
    let changed = false;
    const fixture = await modernFixture(() => {
      const server = new McpServer({ name: 'modern-fixture', version: '1' }, {
        capabilities: { resources: { subscribe: true, listChanged: true }, tools: { listChanged: true }, prompts: { listChanged: true } },
        cacheHints: { 'resources/list': { ttlMs: 60_000, cacheScope: 'private' } },
      });
      server.registerTool('alpha', { inputSchema: z.object({ shard: z.string().meta({ 'x-mcp-header': 'Shard' }), value: z.string() }) }, async ({ value }) => ({ content: [{ type: 'text', text: value }], structuredContent: ['array', 1, true] }));
      if (changed) server.registerTool('beta', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'new catalog' }] }));
      server.registerResource('panel', 'ui://panel', { mimeType: 'text/html;profile=mcp-app' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: '<script>throw new Error("must stay inert")</script>' }] }));
      server.registerResource('file', new ResourceTemplate('doc://{name}', { list: undefined }), {}, async (uri, variables) => ({ contents: [{ uri: uri.href, text: String(variables.name) }] }));
      server.registerPrompt('review', { argsSchema: z.object({ code: completable(z.string(), value => ['one', 'only'].filter(item => item.startsWith(value))) }) }, ({ code }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Review ${code}` } }] }));
      return server;
    });
    let catalogChanged!: () => void;
    const updated = new Promise<void>(resolve => { catalogChanged = resolve; });
    let resourceChanged!: () => void;
    const notified = new Promise<void>(resolve => { resourceChanged = resolve; });
    const connected = await connectMcpServers([{ name: 'modern', transport: 'http', url: fixture.url, protocol: '2026-07-28', timeoutMs: 3_000 }], {
      onExtensionsChanged: () => catalogChanged(), onResourceUpdated: (_server, uri) => { if (uri === 'ui://panel') resourceChanged(); },
    });
    cleanups.push(connected.close);
    expect(connected.servers[0]).toMatchObject({ protocol: '2026-07-28', era: 'modern' });
    expect(fixture.requests.some(item => item.body.method === 'initialize')).toBe(false);
    expect(fixture.requests.some(item => item.body.method === 'server/discover')).toBe(true);
    const tool = connected.extensions[0]!.tools!.find(item => item.name === mcpToolName('modern', 'alpha'))!;
    const result = await tool.execute({ shard: 'east west', value: 'hello modern' }, {} as ToolExecutionApi, context);
    expect(JSON.stringify(result.output)).toContain('hello modern');
    expect(JSON.stringify(result.output)).toContain('Structured content:');
    const call = fixture.requests.find(item => item.body.method === 'tools/call')!;
    expect(call.headers['mcp-method']).toBe('tools/call');
    expect(call.headers['mcp-name']).toBe('alpha');
    expect(call.headers['mcp-param-shard']).toBe('east west');
    expect(JSON.stringify(call.body)).toContain('io.modelcontextprotocol/clientCapabilities');
    await connected.listResources('modern'); await connected.listResources('modern');
    expect(fixture.requests.filter(item => item.body.method === 'resources/list')).toHaveLength(1);
    expect((await connected.readResource('modern', 'ui://panel')).contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
    expect((await connected.getPrompt('modern', { name: 'review', arguments: { code: 'x' } })).messages[0]?.content).toMatchObject({ text: 'Review x' });
    expect((await connected.complete('modern', { ref: { type: 'ref/prompt', name: 'review' }, argument: { name: 'code', value: 'on' } })).completion.values).toEqual(['one', 'only']);
    const subscription = await connected.subscribeResources('modern', ['ui://panel']);
    await fixture.handler.notify.resourceUpdated('ui://panel'); await notified; await subscription.close();
    changed = true; await fixture.handler.notify.toolsChanged(); await updated;
    expect(connected.extensions[0]!.tools!.some(item => item.name === mcpToolName('modern', 'beta'))).toBe(true);
    expect(connected.extensions[0]!.tools!.every(item => item.replay === 'unsafe')).toBe(true);
  });

  it('fulfills MRTR through a real durable question instead of approving automatically', async () => {
    let calls = 0;
    const fixture = await modernFixture(() => {
      const server = new McpServer({ name: 'elicitation-fixture', version: '1' });
      server.registerTool('confirm', { inputSchema: z.object({}) }, async (_args, ctx) => {
        calls++;
        const approval = acceptedContent(ctx.mcpReq.inputResponses, 'confirmation', z.object({ approved: z.boolean() }));
        if (!approval) return inputRequired({ inputRequests: { confirmation: inputRequired.elicit({ message: 'Approve the requested external action?', requestedSchema: z.object({ approved: z.boolean() }) }) }, requestState: 'opaque-server-state' });
        return { content: [{ type: 'text', text: approval.approved ? 'approved by user' : 'declined by user' }] };
      });
      return server;
    });
    const connected = await connectMcpServers([{ name: 'confirm', transport: 'http', url: fixture.url, protocol: '2026-07-28', subscriptions: false, timeoutMs: 5_000 }]); cleanups.push(connected.close);
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('tool_search', { query: 'confirm external' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall(mcpToolName('confirm', 'confirm'), {}), { stopReason: 'toolUse' }), fauxAssistantMessage('finished'),
    ]);
    const registry = createRegistry(); registry.install(createToolSearchExtension());
    let harness!: Harness;
    registry.install(createQuestionsExtension({ getHarness: () => harness }));
    for (const extension of connected.extensions) registry.install(extension);
    harness = await Harness.open(new MemoryStorage(), { models, registry }, context); cleanups.push(() => harness.close(context));
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
    const pending = pendingQuestion(harness, root.id);
    const submission = await root.submit({ type: 'input', content: 'Ask for real confirmation' }, context);
    const question = await pending;
    expect(calls).toBe(1);
    await answerQuestion(harness, root.id, question.id, '{"approved":true}', context);
    expect((await submission.wait(context)).status).toBe('done');
    expect(calls).toBe(2);
    expect(JSON.stringify((await root.entries({}, 100, undefined, context)).items)).toContain('approved by user');
    const retry = fixture.requests.filter(item => item.body.method === 'tools/call').at(-1)!;
    expect(JSON.stringify(retry.body)).toContain('opaque-server-state');
    expect(JSON.stringify(retry.body)).toContain('inputResponses');
  });

  it('speaks modern stdio through the official server and legacy mode remains explicit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morphess-modern-stdio-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const script = join(directory, 'server.mjs');
    await writeFile(script, `import {McpServer} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server'))};\nimport {serveStdio} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};\nconst handle=serveStdio(()=>{const server=new McpServer({name:'modern-stdio',version:'1'});server.registerTool('hello',{},async()=>({content:[{type:'text',text:'stdio-modern'}]}));return server;});\n`);
    const connected = await connectMcpServers([{ name: 'stdio', transport: 'stdio', command: process.execPath, args: [script], protocol: 'auto', subscriptions: false, timeoutMs: 3_000 }]); cleanups.push(connected.close);
    expect(connected.servers[0]?.era).toBe('modern');
    const result = await connected.extensions[0]!.tools![0]!.execute({}, {} as ToolExecutionApi, context);
    expect(JSON.stringify(result.output)).toContain('stdio-modern');
  });
});

it('retains Tasks extension handles durably and controls the task without replaying its originating effect', async () => {
  let effectCalls = 0;
  let updates = 0;
  let cancelled = false;
  const now = new Date().toISOString();
  const base = { taskId: 'job-1', createdAt: now, lastUpdatedAt: now, ttlMs: 60_000, pollIntervalMs: 100 };
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += String(chunk);
    const message = JSON.parse(text) as { id: string | number; method: string; params?: Record<string, unknown> };
    const meta = { 'io.modelcontextprotocol/serverInfo': { name: 'tasks-fixture', version: '1' } };
    let result: Record<string, unknown>;
    if (message.method === 'server/discover') result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } }, _meta: meta };
    else if (message.method === 'tools/list') result = { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [{ name: 'start', description: 'Start external work once', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: { final: { type: 'string' } }, required: ['final'] } }] };
    else if (message.method === 'tools/call') { effectCalls++; result = { resultType: 'task', ...base, status: 'working' }; }
    else if (message.method === 'tasks/get') result = { resultType: 'complete', ...base, status: cancelled ? 'cancelled' : updates ? 'completed' : 'working', ...(updates ? { result: { resultType: 'complete', content: [{ type: 'text', text: 'finished externally' }] } } : {}) };
    else if (message.method === 'tasks/update') { updates++; result = { resultType: 'complete' }; }
    else if (message.method === 'tasks/cancel') { cancelled = true; result = { resultType: 'complete' }; }
    else { response.writeHead(400); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connected = await connectMcpServers([{ name: 'tasks', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, protocol: '2026-07-28', tasks: true, subscriptions: false, timeoutMs: 5_000 }]); cleanups.push(connected.close);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('tool_search', { query: 'tasks start work' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall(mcpToolName('tasks', 'start'), {}), { stopReason: 'toolUse' }), fauxAssistantMessage('Task retained'),
  ]);
  const registry = createRegistry(); registry.install(createToolSearchExtension()); for (const extension of connected.extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context); cleanups.push(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  expect((await (await root.submit({ type: 'input', content: 'Start a task once' }, context)).wait(context)).status).toBe('done');
  const key = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(['tasks', 'job-1'])).digest('hex');
  const { McpTaskDoc } = await import('../src/mcp/index.js');
  const retained = await harness.snapshot(McpTaskDoc, key, context);
  expect(retained).toMatchObject({ server: 'tasks', taskId: 'job-1' });
  expect(effectCalls).toBe(1);
  expect((await connected.getTask('tasks', 'job-1')).status).toBe('working');
  await connected.updateTask('tasks', 'job-1', { confirm: { action: 'accept', content: { approved: true } } });
  expect((await connected.getTask('tasks', 'job-1')).status).toBe('completed');
  await connected.cancelTask('tasks', 'job-1');
  expect((await connected.getTask('tasks', 'job-1')).status).toBe('cancelled');
  expect(effectCalls).toBe(1);
});

it('requires explicit sampling approval and runs every sampling request through native budget admission', async () => {
  const fixture = await modernFixture(() => {
    const server = new McpServer({ name: 'sampling-fixture', version: '1' });
    server.registerTool('sample', { inputSchema: z.object({}) }, async (_args, ctx) => {
      const result = ctx.mcpReq.inputResponses?.summary as { content?: { text?: string } } | undefined;
      if (!result) return inputRequired({ inputRequests: { summary: inputRequired.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'Summarize only this explicit text' } }], maxTokens: 64, includeContext: 'none' }) } });
      return { content: [{ type: 'text', text: result.content?.text ?? 'missing sample' }] };
    });
    return server;
  });
  const connected = await connectMcpServers([{ name: 'sample', transport: 'http', url: fixture.url, protocol: '2026-07-28', sampling: true, subscriptions: false, timeoutMs: 5_000 }]); cleanups.push(connected.close);
  const faux = fauxProvider(); const baseModels = createModels(); baseModels.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('tool_search', { query: 'sample sampling' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall(mcpToolName('sample', 'sample'), {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('sampled answer'), fauxAssistantMessage('outer final'),
  ]);
  const { withBudget } = await import('../src/runtime/budgets.js');
  let admissions = 0;
  const models = withBudget(baseModels, async session => { expect(session).toBeTypeOf('string'); admissions++; return { settle: async () => {} }; });
  const registry = createRegistry(); registry.install(createToolSearchExtension());
  let harness!: Harness; registry.install(createQuestionsExtension({ getHarness: () => harness }));
  for (const extension of connected.extensions) registry.install(extension);
  harness = await Harness.open(new MemoryStorage(), { models, registry }, context); cleanups.push(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  const pending = pendingQuestion(harness, root.id);
  const submission = await root.submit({ type: 'input', content: 'Request a supervised sample' }, context);
  const question = await pending;
  expect(question.question).toContain('billed model call');
  expect(faux.state.callCount).toBe(2);
  expect(admissions).toBe(2);
  await answerQuestion(harness, root.id, question.id, 'approve', context);
  const sharing = await pendingQuestion(harness, root.id);
  expect(sharing.question).toContain('sampled answer');
  expect(admissions).toBe(3);
  await answerQuestion(harness, root.id, sharing.id, 'approve', context);
  expect((await submission.wait(context)).status).toBe('done');
  expect(admissions).toBe(4); expect(faux.state.callCount).toBe(4);
  expect(JSON.stringify((await root.entries({}, 100, undefined, context)).items)).toContain('sampled answer');
});

it('shares only explicitly configured roots through MRTR and refuses out-of-invocation elicitation', async () => {
  const fixture = await modernFixture(() => {
    const server = new McpServer({ name: 'roots-fixture', version: '1' });
    server.registerTool('roots', { inputSchema: z.object({}) }, async (_args, ctx) => {
      const value = ctx.mcpReq.inputResponses?.roots as { roots?: unknown[] } | undefined;
      if (!value) return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } });
      return { content: [{ type: 'text', text: JSON.stringify(value.roots) }] };
    });
    server.registerTool('elicit', { inputSchema: z.object({}) }, async () => inputRequired({ inputRequests: { question: inputRequired.elicit({ message: 'Must not auto-approve', requestedSchema: z.object({ approve: z.boolean() }) }) } }));
    return server;
  });
  const connected = await connectMcpServers([{ name: 'roots', transport: 'http', url: fixture.url, protocol: '2026-07-28', roots: ['/explicit/fixture'], subscriptions: false }]); cleanups.push(connected.close);
  expect(JSON.stringify(await connected.callTool('roots', 'roots', {}))).toContain('file:///explicit/fixture');
  await expect(connected.callTool('roots', 'elicit', {})).rejects.toThrow('active durable tool invocation');
});

it('exposes Skills over MCP with verified files and never activates or executes received instructions', async () => {
  const { SkillsExtension, memorySkillFiles } = await import('@modelcontextprotocol/server/ext/skills');
  const catalog = await SkillsExtension.load(memorySkillFiles({
    'review/SKILL.md': '---\nname: review\ndescription: Review code with evidence.\n---\n# Review\nRead references/checklist.md as data.\n',
    'review/references/checklist.md': 'Check tests and invariants.\n',
  }));
  const fixture = await modernFixture(() => { const server = new McpServer({ name: 'skills-fixture', version: '1' }); catalog.attach(server); return server; });
  const connected = await connectMcpServers([{ name: 'skills', transport: 'http', url: fixture.url, protocol: '2026-07-28', subscriptions: false }]); cleanups.push(connected.close);
  const listing = await connected.listSkills('skills');
  expect(listing.skills).toHaveLength(1);
  const entry = listing.skills[0]!;
  const manifest = await connected.readSkill('skills', entry.uri);
  expect(manifest).toMatchObject({ verified: true, frontmatter: { name: 'review' } });
  expect((await connected.readSkill('skills', entry.uri, 'references/checklist.md')).text).toContain('invariants');
  await expect(connected.readSkill('skills', entry.uri, '../../outside')).rejects.toThrow();
  expect(connected.extensions[0]!.tools!.some(tool => tool.name === mcpToolName('skills', 'morphess:skill_read'))).toBe(true);
  expect(connected.extensions[0]!.sections ?? []).toEqual([]);
});

it('streams modern progress and closes the request stream on cancellation without issuing another effect', async () => {
  let calls = 0;
  let markCancelled!: () => void;
  const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
  const fixture = await modernFixture(() => {
    const server = new McpServer({ name: 'progress-fixture', version: '1' });
    server.registerTool('slow', { inputSchema: z.object({}) }, async (_args, ctx) => {
      calls++;
      const signal = ctx.mcpReq.signal;
      const stopped = new Promise<void>(resolve => {
        if (signal.aborted) { markCancelled(); resolve(); }
        else signal.addEventListener('abort', () => { markCancelled(); resolve(); }, { once: true });
      });
      const token = ctx.mcpReq._meta?.progressToken;
      if (token !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: 'working' } });
      await stopped;
      return { content: [{ type: 'text', text: 'cancelled' }] };
    });
    return server;
  });
  const connected = await connectMcpServers([{ name: 'progress', transport: 'http', url: fixture.url, protocol: '2026-07-28', subscriptions: false, timeoutMs: 3_000 }]); cleanups.push(connected.close);
  const controller = new AbortController();
  const details: unknown[] = [];
  const api = { details: async (value: unknown) => { details.push(value); controller.abort(new Error('user stopped')); } } as unknown as ToolExecutionApi;
  const tool = connected.extensions[0]!.tools!.find(item => item.name === mcpToolName('progress', 'slow'))!;
  await expect(tool.execute({}, api, withAbortSignal(controller.signal, context))).rejects.toThrow();
  await awaitWithContext(cancelled, withAbortSignal(AbortSignal.timeout(2_000), context));
  expect(details).toEqual([{ server: 'progress', progress: 1, total: 2, message: 'working' }]);
  expect(calls).toBe(1);
  expect(fixture.requests.some(item => item.body.method === 'notifications/cancelled')).toBe(false);
});

it('carries modern log levels in request metadata and exposes bounded log notifications', async () => {
  const fixture = await modernFixture(() => {
    const server = new McpServer({ name: 'logging-fixture', version: '1' }, { capabilities: { logging: {} } });
    server.registerTool('log', { inputSchema: z.object({}) }, async (_args, ctx) => {
      await ctx.mcpReq.log('info', 'informational');
      await ctx.mcpReq.log('error', { message: 'failure details' });
      return { content: [{ type: 'text', text: 'logged' }] };
    });
    return server;
  });
  const logs: unknown[] = [];
  const connected = await connectMcpServers([{ name: 'logs', transport: 'http', url: fixture.url, protocol: '2026-07-28', subscriptions: false }], { onLog: (_name, message) => logs.push(message) }); cleanups.push(connected.close);
  await connected.setLogLevel('logs', 'warning');
  await connected.callTool('logs', 'log', {});
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ level: 'error', data: { message: 'failure details' } });
  expect(JSON.stringify(fixture.requests.find(request => request.body.method === 'tools/call')!.body)).toContain('io.modelcontextprotocol/logLevel');
  expect(fixture.requests.some(request => request.body.method === 'logging/setLevel')).toBe(false);
  expect(connected.extensions[0]!.tools!.some(tool => tool.name === mcpToolName('logs', 'morphess:log_level'))).toBe(true);
});
