import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type, type Message } from '@earendil-works/pi-ai';
import { AgentDoc, defineExtension, defineTool, type ConversationId, type EntryId, type EntryRecord, type Extension, type SnapshotEvent } from '@earendil-works/pi-durable';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { createQuestionsExtension } from '../src/interaction/index.js';
import { WorkDoc } from '../src/workflow/work.js';
import { ConversationModeDoc, TuiController } from '../src/tui/controller.js';
import { PREVIEW_LIMITS, previewDetail, sanitizeText, TuiProjection } from '../src/tui/state.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function entry(id: number, message: Message): EntryRecord {
  return { id: id as EntryId, conversationId: 1 as ConversationId, kind: `pi.${message.role}`, model: [message] };
}
function snapshot(entries: EntryRecord[] = []): SnapshotEvent {
  return { type: 'snapshot', entries, tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} } };
}

async function setup(options: { extensions?: Extension[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-tui-controller-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  let runtime!: MorphessRuntime;
  const questions = createQuestionsExtension({ getHarness: () => runtime.harness });
  runtime = await MorphessRuntime.open(defaultConfig(directory), { models, extensions: [questions, ...options.extensions ?? []] });
  cleanups.push(() => runtime.close());
  const controller = await TuiController.open(runtime); cleanups.push(() => controller.close());
  return { directory, faux, runtime, controller };
}

describe('bounded TUI event projection', () => {
  it('caps rows and text, strips terminal controls, and preserves unchanged row identity across snapshots', () => {
    const projection = new TuiProjection();
    const entries = Array.from({ length: 100 }, (_, index) => entry(index + 1, { role: 'user', content: `${index}:` + 'x'.repeat(50_000), timestamp: index }));
    projection.snapshot(snapshot(entries));
    expect(projection.entries).toHaveLength(PREVIEW_LIMITS.entries);
    expect(projection.entries.every(row => row.text.length <= PREVIEW_LIMITS.text)).toBe(true);
    expect(projection.entries[0]?.entryId).toBe(21);
    const last = projection.entries.at(-1);
    projection.snapshot(snapshot(entries));
    expect(projection.entries.at(-1)).toBe(last);
    expect(sanitizeText('\x1b]0;owned\x07\x1b[31mHello\x1b[0m\0\u202eworld')).toBe('Helloworld');
    expect(previewDetail({ payload: 'x'.repeat(1_000_000) }).length).toBeLessThanOrEqual(PREVIEW_LIMITS.detail);
  });

  it('handles full initial messages, deltas, replacement blocks/messages, and stable final row identity', () => {
    const projection = new TuiProjection();
    projection.snapshot(snapshot([entry(1, { role: 'user', content: 'Question', timestamp: 1 })]));
    const user = projection.entries[0];
    projection.apply([{ type: 'message_start', message: fauxAssistantMessage([{ type: 'text', text: 'Initial' }, { type: 'thinking', thinking: 'Reason' }]) }]);
    const initial = projection.entries.at(-1)!;
    expect(initial.text).toBe('Initial'); expect(initial.thinking).toBe('Reason');
    projection.apply([{ type: 'message_update', usage: fauxAssistantMessage('').usage, changes: [
      { type: 'text_delta', contentIndex: 0, delta: ' delta' },
      { type: 'thinking_delta', contentIndex: 1, delta: ' more' },
    ] }]);
    expect(projection.entries.at(-1)).toMatchObject({ id: initial.id, text: 'Initial delta', thinking: 'Reason more', revision: initial.revision + 1 });
    projection.apply([{ type: 'message_update', usage: fauxAssistantMessage('').usage, changes: [{ type: 'block', contentIndex: 0, block: { type: 'text', text: 'Replaced' } }] }]);
    expect(projection.entries.at(-1)?.text).toBe('Replaced');
    projection.apply([{ type: 'message_update', usage: fauxAssistantMessage('').usage, changes: [{ type: 'message', message: fauxAssistantMessage('Whole replacement') }] }]);
    const final = entry(2, fauxAssistantMessage('Whole replacement'));
    projection.apply([{ type: 'message_end', entry: final }, { type: 'entry_appended', entry: final }]);
    expect(projection.entries).toHaveLength(2);
    expect(projection.entries.at(-1)).toMatchObject({ id: initial.id, entryId: 2, status: 'done', text: 'Whole replacement' });
    expect(projection.entries[0]).toBe(user);
  });

  it('keeps bounded tool detail and applies retained-window output updates', () => {
    const projection = new TuiProjection();
    projection.apply([{ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read', args: { path: 'file' } }]);
    projection.apply([{ type: 'tool_execution_update', toolCallId: 'tool', toolName: 'read', output: { set: 'abc' } },
      { type: 'tool_execution_update', toolCallId: 'tool', toolName: 'read', output: { trimStart: 1, append: 'def' } }]);
    expect(projection.entries[0]?.text).toBe('bcdef');
    projection.apply([{ type: 'tool_execution_end', toolCallId: 'tool', toolName: 'read', entry: entry(2, {
      role: 'toolResult', toolCallId: 'tool', toolName: 'read', content: [{ type: 'text', text: 'z'.repeat(100_000) }], isError: true, timestamp: 1,
    }) }]);
    expect(projection.entries[0]?.text).toHaveLength(PREVIEW_LIMITS.text);
    expect(projection.entries[0]?.detail).toHaveLength(PREVIEW_LIMITS.detail);
    expect(projection.entries[0]?.status).toBe('error');
  });

  it('omits pure tool-call assistant rows, clears replaced content, and makes empty provider errors legible', () => {
    const projection = new TuiProjection();
    const call = fauxAssistantMessage(fauxToolCall('read', { path: 'file' }), { stopReason: 'toolUse' });
    projection.apply([{ type: 'message_start', message: call }, { type: 'message_end', entry: entry(1, call) }]);
    expect(projection.entries).toEqual([]);
    projection.apply([{ type: 'message_start', message: fauxAssistantMessage('Stale text') },
      { type: 'message_update', usage: call.usage, changes: [{ type: 'message', message: call }] }]);
    expect(projection.entries[0]?.text).toBe('');
    projection.apply([{ type: 'message_end', entry: entry(2, call) }]);
    expect(projection.entries).toEqual([]);
    projection.apply([{ type: 'message_end', entry: entry(3, fauxAssistantMessage([], { stopReason: 'error', errorMessage: '\x1b[31mProvider failed\x1b[0m' })) }]);
    expect(projection.entries[0]).toMatchObject({ role: 'assistant', text: 'Provider failed', status: 'error' });
  });
});

describe('native TUI session controller', () => {
  it('returns on input admission, watches completion and plans, and leaves runtime alive on UI close', async () => {
    const { runtime, controller, faux } = await setup();
    let release!: () => void;
    faux.setResponses([async () => { await new Promise<void>(resolve => { release = resolve; }); return fauxAssistantMessage('Native answer'); }]);
    const id = await controller.send('Hello');
    expect(id).toBeTypeOf('number');
    await expect.poll(() => typeof release).toBe('function');
    await expect.poll(() => controller.state.busy).toBe(true);
    await runtime.root.commit(async tx => { (await tx.doc(WorkDoc, runtime.root.id)).plan = [{ step: 'Inspect code', status: 'in_progress' }]; }, context);
    await expect.poll(() => controller.state.plan).toEqual([{ step: 'Inspect code', status: 'in_progress' }]);
    release();
    await expect.poll(() => controller.state.entries.some(row => row.role === 'assistant' && row.text === 'Native answer' && row.status === 'done')).toBe(true);
    await expect.poll(() => controller.state.busy).toBe(false);
    expect(controller.state.context?.contextWindow).toBe(1_000_000);
    await controller.close();
    faux.setResponses([fauxAssistantMessage('Runtime still alive')]);
    const next = await runtime.submit({ type: 'input', content: 'Continue outside UI' });
    expect((await runtime.answer(next.id)).text).toBe('Runtime still alive');
  });

  it('persists plan tool restriction atomically and restores the exact previous enabled tools', async () => {
    const { runtime, controller } = await setup();
    const current = await runtime.root.agent(context);
    const selected = [...current.tools, ...current.callable].filter(tool => ['read', 'write', 'ask_user', 'delegate'].includes(tool.name));
    const unique = [...new Map(selected.map(tool => [tool.name, tool])).values()];
    await runtime.root.configure({ tools: unique }, context);
    const before = (await runtime.root.agent(context)).tools.map(tool => tool.name).sort();
    await controller.setMode('plan');
    expect((await runtime.root.agent(context)).tools.map(tool => tool.name).sort()).toEqual(before.filter(name => name !== 'write'));
    expect(await runtime.harness.snapshot(ConversationModeDoc, runtime.root.id, context)).toMatchObject({ mode: 'plan', restore: expect.arrayContaining(before) });
    expect((await runtime.harness.snapshot(AgentDoc, runtime.root.id, context))?.tools).not.toContain('write');
    await controller.setMode('build');
    expect((await runtime.root.agent(context)).tools.map(tool => tool.name).sort()).toEqual(before);
    expect(controller.state.mode).toBe('build');
  });

  it('preserves enabled model-only tools hidden by modelTools while restoring no unknown tools', async () => {
    const tool = defineTool({ name: 'model_only', description: 'Hidden model-only example', parameters: Type.Object({}),
      callers: ['model'], replay: 'unsafe', execute: async () => ({ output: [] }) });
    const { runtime, controller } = await setup({ extensions: [defineExtension({ name: 'model-only-example', tools: [tool] })] });
    await runtime.root.configure({ modelTools: { remove: [tool] } }, context);
    const before = await runtime.harness.snapshot(AgentDoc, runtime.root.id, context);
    expect((await runtime.root.agent(context)).tools.some(item => item.name === tool.name)).toBe(false);
    await controller.setMode('plan');
    expect((await runtime.harness.snapshot(AgentDoc, runtime.root.id, context))?.tools).not.toContain(tool.name);
    await controller.setMode('build');
    const restored = await runtime.harness.snapshot(AgentDoc, runtime.root.id, context);
    expect(restored?.tools).toContain(tool.name);
    expect(restored?.modelTools).toEqual(before?.modelTools);
    expect((await runtime.root.agent(context)).tools.some(item => item.name === tool.name)).toBe(false);
  });

  it('requires active delegated work to stop before entering plan mode', async () => {
    const { runtime, controller, faux } = await setup();
    let release!: () => void;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('delegate', { task: 'A coder is already working', role: 'coder' }), { stopReason: 'toolUse' }),
      async () => { await new Promise<void>(resolve => { release = resolve; }); return fauxAssistantMessage('Child complete'); },
      fauxAssistantMessage('Parent complete'),
    ]);
    await controller.send('Delegate work');
    await expect.poll(() => typeof release).toBe('function');
    await expect(controller.setMode('plan')).rejects.toThrow('Stop active work');
    expect((await runtime.harness.snapshot(ConversationModeDoc, runtime.root.id, context))?.mode).toBe('build');
    expect((await runtime.root.agent(context)).tools.some(tool => tool.name === 'write')).toBe(true);
    release(); await runtime.root.waitForIdle(context);
    await controller.setMode('plan');
    expect((await runtime.root.agent(context)).tools.some(tool => tool.name === 'write')).toBe(false);
  });

  it('keeps plan tool enforcement when reopened headlessly without importing the TUI module', async () => {
    const { directory, controller, runtime } = await setup();
    await controller.setMode('plan');
    await controller.close(); await runtime.close();
    const source = `
      import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
      import { defaultConfig } from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
      import { MorphessRuntime } from ${JSON.stringify(new URL('../src/runtime/runtime.ts', import.meta.url).href)};
      import { createModels } from '@earendil-works/pi-ai/models';
      import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
      const models=createModels(); models.setProvider(fauxProvider().provider);
      const runtime=await MorphessRuntime.open(defaultConfig(${JSON.stringify(directory)}),{models});
      try { console.log(JSON.stringify((await runtime.root.agent(BACKGROUND_CONTEXT)).tools.map(tool=>tool.name))); }
      finally { await runtime.close(); }
    `;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), timeout: 10_000 });
    const names: string[] = JSON.parse(result.stdout.trim());
    expect(names).toContain('read'); expect(names).toContain('delegate');
    expect(names).not.toContain('write'); expect(names).not.toContain('bash'); expect(names).not.toContain('tool_search');
  });

  it('prevents a newly delegated coder from escaping the parent plan tool restriction', async () => {
    const { directory, runtime, controller, faux } = await setup();
    await controller.setMode('plan');
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('delegate', { task: 'Try a write', role: 'coder' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('write', { path: 'forbidden.txt', content: 'must not be written' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Child could not write'), fauxAssistantMessage('Plan remains read-only'),
    ]);
    await controller.send('Delegate in plan mode');
    await runtime.root.waitForIdle(context);
    await expect(readFile(join(directory, 'forbidden.txt'), 'utf8')).rejects.toThrow();
    await expect.poll(() => controller.state.entries.some(row => row.text === 'Plan remains read-only')).toBe(true);
    expect(controller.state.mode).toBe('plan');
  });

  it('ignores stale completion events after switching sessions and lists/forks durable conversations', async () => {
    const { runtime, controller, faux } = await setup();
    let release!: () => void;
    faux.setResponses([async () => { await new Promise<void>(resolve => { release = resolve; }); return fauxAssistantMessage('Old session answer'); }]);
    await controller.send('Old session input');
    await expect.poll(() => typeof release).toBe('function');
    const oldId = controller.state.sessionId;
    await controller.newSession(); const freshId = controller.state.sessionId;
    expect(freshId).not.toBe(oldId);
    release(); await runtime.root.waitForIdle(context);
    expect(controller.state.sessionId).toBe(freshId);
    expect(controller.state.entries.some(row => row.text.includes('Old session answer'))).toBe(false);
    faux.setResponses([fauxAssistantMessage('New answer')]);
    await controller.send('New session input');
    await expect.poll(() => controller.state.entries.some(row => row.text === 'New answer' && row.status === 'done')).toBe(true);
    const sessions = await controller.sessions();
    expect(sessions.map(session => session.id)).toEqual(expect.arrayContaining([oldId, freshId]));
    await controller.fork(); expect(controller.state.sessionId).not.toBe(freshId);
    expect(controller.state.entries.some(row => row.text === 'New answer')).toBe(true);
  });

  it('surfaces and answers a root human question through the exact native question ID', async () => {
    const { controller, faux } = await setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Which target?', options: ['Local', 'Preview'] }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Human input received'),
    ]);
    await controller.send('Ask a question');
    await expect.poll(() => controller.state.questions.length).toBe(1);
    const question = controller.state.questions[0]!;
    expect(question.id).toBe(question.taskId);
    await expect(controller.switchSession(999_999_999)).rejects.toThrow('not found');
    expect(controller.state.sessionId).toBe(question.conversationId);
    await controller.answer(question.id, 'Local');
    await expect.poll(() => controller.state.questions.length).toBe(0);
    await expect.poll(() => controller.state.entries.some(row => row.text === 'Human input received')).toBe(true);
  });

  it('sanitizes question text and choices while preserving raw model source fidelity', async () => {
    const { runtime, controller, faux } = await setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('ask_user', { question: '\x1b]0;title\x07Target\x1b[2J?', options: ['\x1b[31mLocal', 'Preview\u202e'] }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done'),
    ]);
    await controller.send('Question');
    await expect.poll(() => controller.state.questions.length).toBe(1);
    expect(controller.state.questions[0]?.question).toBe('Target?');
    expect(controller.state.questions[0]?.options).toEqual(['Local', 'Preview']);
    const native = await runtime.root.entries({}, 100, undefined, context);
    expect(JSON.stringify(native.items)).toContain('\\u001b');
    await controller.answer(controller.state.questions[0]!.id, 'Local');
    await expect.poll(() => controller.state.busy).toBe(false);
  });

  it('surfaces a delegated child question while the parent is selected and routes its answer back to the child', async () => {
    const { runtime, controller, faux } = await setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('delegate', { task: 'Ask which target', role: 'coder' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Child target?' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Child received your input'), fauxAssistantMessage('Parent completed'),
    ]);
    await controller.send('Delegate a question');
    await expect.poll(() => controller.state.questions.length).toBe(1);
    const question = controller.state.questions[0]!;
    expect(question.conversationId).not.toBe(runtime.root.id);
    expect(controller.state.sessionId).toBe(runtime.root.id);
    await controller.answer(question.id, 'Use local');
    await expect.poll(() => controller.state.entries.some(row => row.text === 'Parent completed')).toBe(true);
    await expect.poll(() => controller.state.questions.length).toBe(0);
  });

  it('lists bounded workspace file matches through a separate guarded environment', async () => {
    const { directory, controller } = await setup();
    await writeFile(join(directory, 'alpha.ts'), 'example'); await writeFile(join(directory, 'beta.md'), 'example');
    await writeFile(join(directory, 'hidden\x1b[31m.ts'), 'control characters are not an interactive path alias');
    expect(await controller.files('.ts')).toContain('alpha.ts');
    expect((await controller.files('')).some(path => path.includes('.morphess'))).toBe(false);
    expect((await controller.files('')).some(path => path.startsWith('hidden'))).toBe(false);
  });
});
