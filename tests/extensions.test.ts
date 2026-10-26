import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type, type FauxResponseStep } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, type Extension } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createDelegationExtension, loadExtensions } from '../src/extensions/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function run(responses: FauxResponseStep[], extensions: Extension[]) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  try {
    const settled = await (await root.submit({ type: 'input', content: 'delegate the task' }, context)).wait(context);
    await harness.waitForIdle(context);
    const entries = (await root.entries({}, 100, undefined, context)).items;
    return { settled, entries, storage, rootId: root.id };
  } finally { await harness.close(context); }
}

describe('durable foreground delegation', () => {
  it('runs a Pi-owned child and restricts read-only roles without enabling absent tools', async () => {
    let childTools: string[] = [];
    const child: FauxResponseStep = request => {
      childTools = request.messages.flatMap(message => message.role === 'system' ? (message.toolsAdded ?? []).map(tool => tool.name) : []);
      return fauxAssistantMessage('child evidence');
    };
    const extra = defineExtension({ name: 'test-tools', tools: ['read', 'write', 'bash'].map(name => defineTool({
      name, description: name, parameters: Type.Object({}), replay: 'unsafe',
      execute: async () => ({ output: [] }),
    })) });
    const result = await run([
      fauxAssistantMessage(fauxToolCall('delegate', { task: 'research files', role: 'researcher' }), { stopReason: 'toolUse' }),
      child,
      fauxAssistantMessage('parent final'),
    ], [extra, createDelegationExtension({ maxConcurrentAgents: 2, maxAgentDepth: 4 })]);
    expect(result.settled.status).toBe('done');
    const tool = result.entries.flatMap(entry => entry.model ?? []).find(message => message.role === 'toolResult');
    expect(tool?.role).toBe('toolResult');
    if (tool?.role !== 'toolResult') throw new Error('No delegation result');
    expect(tool.isError, JSON.stringify(tool)).toBe(false);
    expect(childTools).toEqual(['read']);
    const payload = JSON.parse(tool.content.flatMap(part => part.type === 'text' ? [part.text] : []).join(''));
    expect(payload.answer).toBe('child evidence');
    expect(payload.conversationId).toBeTypeOf('number');
  });

  it('enforces a durable session concurrency cap on simultaneous requests', async () => {
    const result = await run([
      fauxAssistantMessage([
        fauxToolCall('delegate', { task: 'one' }, { id: 'first' }),
        fauxToolCall('delegate', { task: 'two' }, { id: 'second' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage('child done'), fauxAssistantMessage('parent final'),
    ], [createDelegationExtension({ maxConcurrentAgents: 1, maxAgentDepth: 1 })]);
    const tools = result.entries.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult');
    expect(tools).toHaveLength(2);
    expect(tools.filter(tool => tool.isError)).toHaveLength(1);
    expect(JSON.stringify(tools)).toContain('concurrency limit');
  });

  it('times out and stops child work while the parent can finish', async () => {
    const result = await run([
      fauxAssistantMessage(fauxToolCall('delegate', { task: 'slow child', timeoutMs: 100 }), { stopReason: 'toolUse' }),
      async () => { await new Promise(resolve => setTimeout(resolve, 250)); return fauxAssistantMessage('late child'); },
      fauxAssistantMessage('parent recovered'),
    ], [createDelegationExtension({ maxConcurrentAgents: 1, maxAgentDepth: 1 })]);
    expect(result.settled.status).toBe('done');
    const tools = result.entries.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult');
    expect(tools[0]?.isError).toBe(true);
    expect(JSON.stringify(tools)).toContain('timed out');
  });

  it('supports explicitly disabling delegation and rejects invalid bounds', () => {
    expect(createDelegationExtension({ maxConcurrentAgents: 1, maxAgentDepth: 0 }).tools).toEqual([]);
    expect(() => createDelegationExtension({ maxConcurrentAgents: 0, maxAgentDepth: 1 })).toThrow('positive');
  });

  it('reattaches to the same durable child and submission after a process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morphess-delegation-')); directories.push(directory);
    const database = join(directory, 'session.sqlite');
    const faux = fauxProvider();
    const models = createModels(); models.setProvider(faux.provider);
    const registry = createRegistry(); registry.install(createDelegationExtension({ maxConcurrentAgents: 1, maxAgentDepth: 1 }));
    let childStarted!: () => void;
    const started = new Promise<void>(resolve => { childStarted = resolve; });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('delegate', { task: 'durable task', role: 'coder' }), { stopReason: 'toolUse' }),
      async (_request, options) => {
        childStarted();
        await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('restart fixture')), { once: true }));
        return fauxAssistantMessage('never reached');
      },
    ]);
    let harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
    try {
      const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
      const submission = await root.submit({ type: 'input', content: 'delegate' }, context);
      await started;
      const before = (await root.commit(tx => tx.scanConversations({}, 10), context)).items;
      expect(before).toHaveLength(2);
      await harness.close(context);
      faux.setResponses([fauxAssistantMessage('recovered child'), fauxAssistantMessage('recovered parent')]);
      harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
      const resumed = await harness.submission(submission.id, context);
      expect((await resumed!.wait(context)).status).toBe('done');
      const reopenedRoot = await harness.root(context);
      const after = (await reopenedRoot.commit(tx => tx.scanConversations({}, 10), context)).items;
      expect(after.map(conversation => conversation.id)).toEqual(before.map(conversation => conversation.id));
      const childRecord = after.find(conversation => conversation.id !== root.id)!;
      const child = (await harness.conversation(childRecord.id, context))!;
      const messages = (await child.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
      expect(messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(JSON.stringify(messages)).toContain('recovered child');
    } finally { await harness.close(context); }
  });
});

describe('trusted extension lifecycle', () => {
  it('loads explicit ESM factories, closes in reverse order, and closes once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morphess-plugins-')); directories.push(directory);
    const log = join(directory, 'log');
    for (const name of ['one', 'two']) {
      await writeFile(join(directory, `${name}.mjs`), `import { appendFile } from 'node:fs/promises'; export function createExtension({workspace}) { return { extensions: [{name: ${JSON.stringify(name)}}], close() { return appendFile(${JSON.stringify(log)}, ${JSON.stringify(name + '\n')}); } }; }`);
    }
    const loaded = await loadExtensions(['./one.mjs', './two.mjs'], { workspace: directory });
    expect(loaded.extensions.map(extension => extension.name)).toEqual(['one', 'two']);
    await loaded.close(); await loaded.close();
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(log, 'utf8')).toBe('two\none\n');
  });

  it('rolls back loaded plugins when a later import fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morphess-plugins-')); directories.push(directory);
    const marker = join(directory, 'closed');
    await writeFile(join(directory, 'ok.mjs'), `import {writeFile} from 'node:fs/promises'; export function createExtension() { return {extensions:[{name:'ok'}],close:()=>writeFile(${JSON.stringify(marker)},'closed')}; }`);
    await expect(loadExtensions(['./ok.mjs', './missing.mjs'], { workspace: directory })).rejects.toThrow();
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(marker, 'utf8')).toBe('closed');
  });
});
