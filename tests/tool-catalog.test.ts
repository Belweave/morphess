import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { AssistantEntry, defineExtension, defineTool, ToolTask, wrapTool, type Extension } from '@earendil-works/pi-durable';
import { defaultConfig, mcpServerSchema } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-catalog-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const config = defaultConfig(directory); config.codemode = false;
  return { directory, faux, models, config };
}
async function openFixture(options: { extensions?: Extension[]; codemode?: boolean; readonly?: boolean; nonInteractive?: boolean } = {}) {
  const result = await fixture(); result.config.codemode = options.codemode ?? false;
  if (options.readonly) result.config.policy.mode = 'read-only';
  const runtime = await MorphessRuntime.open(result.config, { models: result.models, extensions: options.extensions, resume: false, nonInteractive: options.nonInteractive });
  cleanup.push(() => runtime.close());
  return { ...result, runtime };
}
function probe(name: string, extra: Partial<ReturnType<typeof defineTool>> = {}) {
  return defineTool({ name, description: `Description of ${name}`, parameters: Type.Object({ value: Type.Optional(Type.String()) }), replay: 'safe', execute: vi.fn(async () => ({ output: [{ type: 'text' as const, text: 'read result' }] })), ...extra });
}

describe('native tool catalog', () => {
  it.each([[false, 15], [true, 16]] as const)('lists the offered built-in inventory with code mode %s', async (codemode, count) => {
    const { runtime, faux } = await openFixture({ codemode });
    const catalog = await runtime.toolCatalog();
    expect(catalog.tools).toHaveLength(count);
    expect(catalog.tools.some(tool => tool.name === 'codemode')).toBe(codemode);
    expect(new Set(catalog.tools.map(tool => tool.name)).size).toBe(count);
    expect(catalog.tools.every(tool => tool.offeredToModel && tool.selected && tool.enabled)).toBe(true);
    expect(catalog.tools.find(tool => tool.name === 'read')).toMatchObject({ source: 'coding-tools', origin: 'builtin' });
    expect(catalog.tools.find(tool => tool.name === 'bash')).toBeUndefined();
    const blocked = (await runtime.toolCatalog({ name: 'bash' })).tools[0];
    expect(blocked).toMatchObject({ status: 'policy-blocked', replay: 'unsafe', offeredToModel: false, callableByTools: false });
    expect(blocked?.reason).toContain('trusted');
    expect(catalog.tools.every(tool => tool.parameters === undefined)).toBe(true);
    expect(catalog.scheduling).toBe('paused');
    expect(faux.state.callCount).toBe(0);
  });

  it('inspects tool metadata without model credentials or a provider request', async () => {
    const { config } = await fixture();
    config.model.apiKeyEnv = 'MORPHESS_CATALOG_NEVER_CONFIGURED_TEST_KEY';
    const runtime = await MorphessRuntime.open(config, { resume: false }); cleanup.push(() => runtime.close());
    expect((await runtime.toolCatalog({ name: 'read' })).tools[0]?.status).toBe('available');
    expect((await runtime.harness.inspect(context)).scheduling).toBe('paused');
  });

  it('includes exact JSON parameters for named tools and rejects missing names', async () => {
    const { runtime } = await openFixture();
    const catalog = await runtime.toolCatalog({ name: 'read_bytes' });
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]?.parameters).toMatchObject({ type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } } });
    expect(() => JSON.stringify(catalog)).not.toThrow();
    await expect(runtime.toolCatalog({ name: 'nonexistent' })).rejects.toThrow('Tool not found');
  });

  it('distinguishes deferred, disabled, nested-only and model-hidden tools through Pi selections', async () => {
    const deferred = probe('deferred_probe', { deferred: true });
    const nested = probe('nested_probe', { callers: ['tools'] });
    const disabled = probe('disabled_probe');
    const hidden = probe('hidden_probe', { callers: ['model'] });
    const extension = defineExtension({ name: 'catalog-selection', tools: [deferred, nested, disabled, hidden] });
    const { runtime } = await openFixture({ extensions: [extension] });
    await runtime.root.configure({ tools: { remove: [disabled] }, modelTools: { remove: [hidden] } }, context);
    const regular = await runtime.toolCatalog();
    expect(regular.tools.some(tool => tool.name.endsWith('_probe'))).toBe(false);
    const all = await runtime.toolCatalog({ all: true });
    expect(all.tools.find(tool => tool.name === deferred.name)).toMatchObject({ selected: true, enabled: true, deferred: true, deferredPending: true, offeredToModel: false, callableByTools: true, status: 'deferred' });
    expect(all.tools.find(tool => tool.name === nested.name)).toMatchObject({ status: 'nested-only', callableByTools: true, offeredToModel: false });
    expect(all.tools.find(tool => tool.name === disabled.name)).toMatchObject({ selected: true, enabled: false, status: 'disabled' });
    expect(all.tools.find(tool => tool.name === hidden.name)).toMatchObject({ enabled: true, offeredToModel: false, callableByTools: false, status: 'not-offered' });
    await runtime.root.configure({ modelTools: { add: [deferred], remove: [hidden] } }, context);
    expect((await runtime.toolCatalog()).tools.find(tool => tool.name === deferred.name)).toMatchObject({ deferred: true, deferredPending: false, offeredToModel: true, status: 'available' });
  });

  it('resolves the requested session and includes unselected extensions only with all', async () => {
    const extra = probe('session_probe');
    const extension = defineExtension({ name: 'session-extra', tools: [extra] });
    const { runtime } = await openFixture({ extensions: [extension] });
    const session = await runtime.createConversation();
    await session.configure({ extensions: { remove: [extension] } }, context);
    const current = await runtime.toolCatalog();
    expect(current.tools.some(tool => tool.name === extra.name)).toBe(true);
    const selected = await runtime.toolCatalog({ sessionId: session.id });
    expect(selected.sessionId).toBe(session.id);
    expect(selected.tools.some(tool => tool.name === extra.name)).toBe(false);
    expect((await runtime.toolCatalog({ sessionId: session.id, all: true })).tools.find(tool => tool.name === extra.name)).toMatchObject({ selected: false, enabled: false, status: 'not-selected' });
    expect((await runtime.toolCatalog({ sessionId: session.id, name: extra.name })).tools[0]?.status).toBe('not-selected');
    expect((await runtime.harness.inspect(context)).scheduling).toBe('paused');
  });

  it('reports native wrapped metadata, source and shadowing without executing a tool', async () => {
    const first = probe('shared_probe'); const second = probe('shared_probe', { description: 'Selected second provider' });
    const left = defineExtension({ name: 'left-provider', tools: [first] });
    const right = defineExtension({ name: 'right-provider', tools: [second] });
    const wrapper = defineExtension({ name: 'metadata-wrapper', wraps: [wrapTool(second, tool => ({ ...tool, description: 'Wrapped native description', parameters: Type.Object({ wrapped: Type.Boolean() }) }))] });
    const { runtime } = await openFixture({ extensions: [left, right, wrapper] });
    const catalog = await runtime.toolCatalog({ name: 'shared_probe' });
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]).toMatchObject({ source: 'right-provider', origin: 'host', description: 'Wrapped native description', resolved: true, parameters: { properties: { wrapped: { type: 'boolean' } } } });
    expect(catalog.tools[0]?.wrappers).toContain('metadata-wrapper');
    expect(first.execute).not.toHaveBeenCalled(); expect(second.execute).not.toHaveBeenCalled();
    await runtime.root.configure({ extensions: { remove: [right, wrapper] } }, context);
    expect((await runtime.toolCatalog({ name: 'shared_probe' })).tools[0]).toMatchObject({ source: 'left-provider', description: 'Description of shared_probe' });
  });

  it('labels read-only mutations and a noninteractive answer channel as policy blocked', async () => {
    const { runtime } = await openFixture({ readonly: true, nonInteractive: true });
    for (const name of ['bash', 'write', 'edit', 'ask_user']) expect((await runtime.toolCatalog({ name })).tools[0]?.status).toBe('policy-blocked');
    expect((await runtime.toolCatalog({ name: 'read' })).tools[0]?.status).toBe('available');
  });

  it('catalogs queued native tool tasks across SQLite reopen without executing pending effects', async () => {
    const { directory, config, models, faux } = await fixture();
    const effect = probe('pending_effect', { replay: 'unsafe' });
    const extension = defineExtension({ name: 'pending-effects', tools: [effect] });
    let runtime = await MorphessRuntime.open(config, { models, extensions: [extension], resume: false });
    cleanup.push(() => runtime.close());
    const taskId = await runtime.harness.commit(async tx => {
      const message = fauxAssistantMessage(fauxToolCall(effect.name, { value: 'pending' }, { id: 'pending-call' }), { stopReason: 'toolUse' });
      const entry = await tx.appendEntry(AssistantEntry, runtime.root.id, { model: [message] });
      return tx.createTask(ToolTask, { kind: 'model', assistant: entry.id, callId: 'pending-call' }, { ownership: { kind: 'conversation' }, conversationId: runtime.root.id });
    }, context);
    const before = await runtime.harness.getTask(taskId, context);
    expect(before?.state.status).toBe('pending');
    await runtime.close();
    runtime = await MorphessRuntime.open(config, { models, extensions: [extension], resume: false });
    await runtime.toolCatalog({ all: true });
    const after = await runtime.harness.getTask(taskId, context);
    expect(after?.state).toEqual(before?.state);
    expect((await runtime.harness.inspect(context)).scheduling).toBe('paused');
    expect(effect.execute).not.toHaveBeenCalled();
    expect(faux.state.callCount).toBe(0);
    expect(await readFile(join(directory, '.morphess', 'session.sqlite'))).toBeInstanceOf(Buffer);
    runtime.harness.resume();
    await runtime.harness.waitForTask(taskId, context);
    expect(effect.execute).toHaveBeenCalledTimes(1);
  });

  it('does not replay an interrupted safe read while inspecting a reopened runtime', async () => {
    const { config, models, faux } = await fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let attempts = 0;
    const reader = defineTool({
      name: 'replay_read_probe', description: 'Read a constant result with a cancellable first attempt', parameters: Type.Object({}), replay: 'safe',
      async execute(_args, _api, ctx) {
        attempts++;
        if (attempts === 1) {
          entered();
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(ctx.abortSignal?.reason ?? new Error('Read cancelled'));
            if (ctx.abortSignal?.aborted) abort(); else ctx.abortSignal?.addEventListener('abort', abort, { once: true });
          });
        }
        return { output: [{ type: 'text' as const, text: 'Constant read result' }] };
      },
    });
    const extension = defineExtension({ name: 'replay-read', tools: [reader] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall(reader.name, {}), { stopReason: 'toolUse' }), fauxAssistantMessage('Finished reading')]);
    let runtime = await MorphessRuntime.open(config, { models, extensions: [extension] });
    cleanup.push(() => runtime.close());
    const submission = await runtime.submit({ type: 'input', content: 'Read the constant' });
    await started;
    await runtime.close();
    runtime = await MorphessRuntime.open(config, { models, extensions: [extension], resume: false });
    expect((await runtime.harness.inspect(context)).tasks.some(task => task.record.kind === 'pi.tool')).toBe(true);
    await runtime.toolCatalog({ name: reader.name });
    expect((await runtime.harness.inspect(context)).scheduling).toBe('paused');
    expect(attempts).toBe(1);
    expect(faux.state.callCount).toBe(1);
    expect((await runtime.answer(submission.id)).text).toBe('Finished reading');
    expect(attempts).toBe(2);
  });

  it('loads configured trusted plugins and reports their real origin without running plugin tools', async () => {
    const { directory, config, models } = await fixture();
    const marker = join(directory, 'plugin-tool-ran');
    const plugin = join(directory, 'catalog-plugin.mjs');
    await writeFile(plugin, `import {writeFile} from 'node:fs/promises';\nexport function createExtension(){return {name:'configured-plugin',tools:[{name:'plugin_probe',description:'Configured plugin tool',parameters:{type:'object',properties:{}},replay:'unsafe',async execute(){await writeFile(${JSON.stringify(marker)},'ran');return {output:[]}}}]}}`);
    config.plugins = [plugin];
    const runtime = await MorphessRuntime.open(config, { models, resume: false }); cleanup.push(() => runtime.close());
    expect((await runtime.toolCatalog({ name: 'plugin_probe' })).tools[0]).toMatchObject({ source: 'configured-plugin', origin: 'plugin', replay: 'unsafe', status: 'available' });
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('lists discovered configured MCP tools as deferred and never sends a remote tool call', async () => {
    const { directory, config, models } = await fixture();
    const marker = join(directory, 'mcp-tool-ran'); const server = join(directory, 'catalog-mcp.mjs');
    await writeFile(server, `
import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
import {writeFile} from 'node:fs/promises';
const server=new Server({name:'catalog-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'inspect',description:'Read catalog fixture',inputSchema:{type:'object',properties:{}}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>{await writeFile(${JSON.stringify(marker)},'called');return {content:[]}});
await server.connect(new StdioServerTransport());process.stdin.on('end',()=>process.exit(0));
`);
    config.mcp = [mcpServerSchema.parse({ transport: 'stdio', name: 'catalog', command: process.execPath, args: [server], env: {}, timeoutMs: 5000 })];
    const runtime = await MorphessRuntime.open(config, { models, resume: false }); cleanup.push(() => runtime.close());
    expect((await runtime.toolCatalog()).tools.some(tool => tool.origin === 'mcp')).toBe(false);
    const remote = (await runtime.toolCatalog({ all: true })).tools.filter(tool => tool.origin === 'mcp');
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({ deferred: true, deferredPending: true, status: 'deferred', replay: 'unsafe', selected: true });
    expect((await runtime.toolCatalog({ name: remote[0]!.name })).tools[0]?.parameters).toMatchObject({ type: 'object' });
    await expect(readFile(marker)).rejects.toThrow();
  });
});
