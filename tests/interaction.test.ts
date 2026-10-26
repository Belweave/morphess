import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT as context, awaitWithContext, withAbortSignal } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, type ConversationId, type Extension, type Storage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { answerQuestion, createNonInteractiveQuestionsExtension, createQuestionsExtension, listQuestions, QuestionsDoc, type UserQuestion } from '../src/interaction/index.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(storage: Storage = new MemoryStorage(), extensions: Extension[] = []) {
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  let harness!: Harness;
  registry.install(createQuestionsExtension({ getHarness: () => harness }));
  for (const extension of extensions) registry.install(extension);
  harness = await Harness.open(storage, { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  cleanups.push(() => harness.close(context));
  return { faux, root, get harness() { return harness; }, install: (extension: Extension) => registry.install(extension), reopen: async (next: Storage) => {
    await harness.close(context);
    harness = await Harness.open(next, { models, registry }, context);
    return harness;
  } };
}

async function pendingQuestions(harness: Harness, id: ConversationId, count = 1): Promise<UserQuestion[]> {
  await listQuestions(harness, id, context); // Initialize a native watchable document before any question exists.
  const waiting = withAbortSignal(AbortSignal.timeout(5_000), context);
  const watch = (await harness.watchDoc(QuestionsDoc, id, waiting))!;
  try {
    return await awaitWithContext(new Promise<UserQuestion[]>((resolve, reject) => {
      const inspect = (value: typeof watch.value) => {
        const pending = Object.values(value?.questions ?? {}).filter(question => question.status === 'pending');
        if (pending.length >= count) resolve(pending);
      };
      watch.start(async value => { inspect(value); }); inspect(watch.value);
      void watch.closed.then(end => reject(new Error(`Pending question watch ended: ${end.reason}`)));
    }), waiting);
  } finally { await watch.stop(); }
}

describe('durable human questions', () => {
  it('waits for a real freeform answer, exposes the exact task ID, and deduplicates delivery', async () => {
    const fixture = await setup();
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Which target?', options: ['Preview', 'Production'] }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Proceeding with your answer'),
    ]);
    const pending = pendingQuestions(fixture.harness, fixture.root.id);
    const submission = await fixture.root.submit({ type: 'input', content: 'Choose a target' }, context);
    const [question] = await pending;
    expect(fixture.faux.state.callCount).toBe(1);
    expect(question).toMatchObject({ id: expect.any(Number), taskId: expect.any(Number), conversationId: fixture.root.id, question: 'Which target?', options: ['Preview', 'Production'], status: 'pending' });
    expect(question!.id).toBe(question!.taskId);
    const owner = await fixture.harness.getTask(question!.taskId, context);
    expect(owner?.kind).toBe('pi.tool');
    await expect(answerQuestion(fixture.harness, fixture.root.id, question!.id, '   ', context)).rejects.toThrow('blank');
    const delivered = await answerQuestion(fixture.harness, fixture.root.id, question!.id, 'A local staging target', context);
    expect(delivered.status).toBe('answered');
    expect((await submission.wait(context)).status).toBe('done');
    expect(await listQuestions(fixture.harness, fixture.root.id, context)).toEqual([]);
    await expect(answerQuestion(fixture.harness, fixture.root.id, question!.id, 'A local staging target', context)).resolves.toMatchObject({ answer: 'A local staging target' });
    await expect(answerQuestion(fixture.harness, fixture.root.id, question!.id, 'Production', context)).rejects.toThrow('differently');
    const messages = (await fixture.root.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
    const result = messages.find(message => message.role === 'toolResult');
    expect(result?.content).toEqual([{ type: 'text', text: 'A local staging target' }]);
    const other = await fixture.harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    await expect(answerQuestion(fixture.harness, other.id, question!.id, 'wrong owner', context)).rejects.toThrow('not found');
  });

  it('keeps simultaneous questions distinct and routes each answer to its own call', async () => {
    const fixture = await setup();
    fixture.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('ask_user', { question: 'First?' }, { id: 'first' }),
        fauxToolCall('ask_user', { question: 'Second?' }, { id: 'second' }),
      ], { stopReason: 'toolUse' }), fauxAssistantMessage('Both answered'),
    ]);
    const pending = pendingQuestions(fixture.harness, fixture.root.id, 2);
    const submission = await fixture.root.submit({ type: 'input', content: 'Ask two questions' }, context);
    const questions = await pending;
    expect(new Set(questions.map(question => question.id)).size).toBe(2);
    await answerQuestion(fixture.harness, fixture.root.id, questions[0]!.id, 'one', context);
    expect(await listQuestions(fixture.harness, fixture.root.id, context)).toHaveLength(1);
    await answerQuestion(fixture.harness, fixture.root.id, questions[1]!.id, 'two', context);
    expect((await submission.wait(context)).status).toBe('done');
  });

  it('cancels an owned question when its conversation is aborted without supplying synthetic input', async () => {
    const fixture = await setup();
    fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Still needed?' }), { stopReason: 'toolUse' })]);
    const pending = pendingQuestions(fixture.harness, fixture.root.id);
    const submission = await fixture.root.submit({ type: 'input', content: 'Ask then cancel' }, context);
    const [question] = await pending;
    await fixture.root.abort(context);
    expect((await submission.wait(context)).status).toBe('unanswered');
    expect(await listQuestions(fixture.harness, fixture.root.id, context)).toEqual([]);
    await expect(answerQuestion(fixture.harness, fixture.root.id, question!.id, 'too late', context)).rejects.toThrow(/cancelled|no longer pending/);
    expect(fixture.faux.state.callCount).toBe(1);
  });

  it('expires with an error rather than treating timeout as an answer', async () => {
    const fixture = await setup();
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Time limited?', timeoutMs: 100 }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('No answer received'),
    ]);
    const pending = pendingQuestions(fixture.harness, fixture.root.id);
    const submission = await fixture.root.submit({ type: 'input', content: 'Ask briefly' }, context);
    const [question] = await pending;
    expect((await submission.wait(context)).status).toBe('done');
    expect(await listQuestions(fixture.harness, fixture.root.id, context)).toEqual([]);
    const stored = await fixture.harness.snapshot(QuestionsDoc, fixture.root.id, context);
    expect(stored?.questions[String(question!.id)]).toMatchObject({ status: 'expired' });
    expect(stored?.questions[String(question!.id)]?.answer).toBeUndefined();
    const messages = (await fixture.root.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
    expect(messages.some(message => message.role === 'toolResult' && message.isError)).toBe(true);
  });

  it('preserves the same pending question across SQLite close/reopen and accepts an answer before recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morphess-questions-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, 'state.sqlite');
    const fixture = await setup(await openNodeSqliteStorage(database));
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Durable question?', options: ['One', 'Two'] }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Recovered with the answer'),
    ]);
    const pending = pendingQuestions(fixture.harness, fixture.root.id);
    const submission = await fixture.root.submit({ type: 'input', content: 'Ask durably' }, context);
    const [question] = await pending;
    await fixture.harness.close(context);
    await fixture.reopen(await openNodeSqliteStorage(database));
    const resumed = await listQuestions(fixture.harness, fixture.root.id, context);
    expect(resumed).toEqual([question]);
    await answerQuestion(fixture.harness, fixture.root.id, question!.id, 'Two', context);
    const resumedSubmission = (await fixture.harness.submission(submission.id, context))!;
    expect((await resumedSubmission.wait(context)).status).toBe('done');
    const stored = await fixture.harness.snapshot(QuestionsDoc, fixture.root.id, context);
    expect(Object.keys(stored!.questions)).toEqual([String(question!.id)]);
    expect(stored!.questions[String(question!.id)]).toMatchObject({ taskId: question!.taskId, answer: 'Two', status: 'answered' });
    expect(fixture.faux.state.callCount).toBe(2);
  });

  it('keeps the original deadline across restart and rejects answers after downtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morphess-question-timeout-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, 'state.sqlite');
    const fixture = await setup(await openNodeSqliteStorage(database));
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Before deadline?', timeoutMs: 100 }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Expired while away'),
    ]);
    const pending = pendingQuestions(fixture.harness, fixture.root.id);
    const submission = await fixture.root.submit({ type: 'input', content: 'Ask with a deadline' }, context);
    const [question] = await pending;
    await fixture.harness.close(context);
    await new Promise(resolve => setTimeout(resolve, 120));
    await fixture.reopen(await openNodeSqliteStorage(database));
    await expect(answerQuestion(fixture.harness, fixture.root.id, question!.id, 'late', context)).rejects.toThrow('expired');
    expect(await listQuestions(fixture.harness, fixture.root.id, context)).toEqual([]);
    expect((await (await fixture.harness.submission(submission.id, context))!.wait(context)).status).toBe('done');
    const stored = await fixture.harness.snapshot(QuestionsDoc, fixture.root.id, context);
    expect(stored?.questions[String(question!.id)]).toMatchObject({ status: 'expired', deadline: question!.deadline });
  });
});

describe('hosts without an interactive answer channel', () => {
  it('blocks only new ask_user calls and tells the model to return its question as text', async () => {
    const echo = defineExtension({ name: 'echo-example', tools: [defineTool({ name: 'echo', description: 'Echo test',
      parameters: Type.Object({}), replay: 'safe', execute: async () => ({ output: [{ type: 'text', text: 'Other tools still execute' }] }) })] });
    const fixture = await setup(new MemoryStorage(), [createNonInteractiveQuestionsExtension(), echo]);
    let prompt = '';
    fixture.faux.setResponses([
      request => { prompt = JSON.stringify(request.messages); return fauxAssistantMessage(fauxToolCall('ask_user', { question: 'Do not block this host' }), { stopReason: 'toolUse' }); },
      fauxAssistantMessage(fauxToolCall('echo', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Please provide the missing setting in your next request.'),
    ]);
    const submission = await fixture.root.submit({ type: 'input', content: 'Do a headless task' }, context);
    expect((await submission.wait(context)).status).toBe('done');
    expect(prompt).toContain('no interactive answer channel');
    expect(await listQuestions(fixture.harness, fixture.root.id, context)).toEqual([]);
    const messages = (await fixture.root.entries({}, 100, undefined, context)).items.flatMap(entry => entry.model ?? []);
    expect(messages.find(message => message.role === 'toolResult' && message.toolName === 'ask_user')).toMatchObject({ isError: true });
    expect(messages.find(message => message.role === 'toolResult' && message.toolName === 'echo')).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Other tools still execute' }] });
  });

  it('keeps an already-persisted question pending through reopening under a noninteractive host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'morphess-noninteractive-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, 'state.sqlite');
    const fixture = await setup(await openNodeSqliteStorage(database));
    fixture.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('ask_user', { question: 'An existing durable question' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('The existing question was answered'),
    ]);
    const pending = pendingQuestions(fixture.harness, fixture.root.id);
    const submission = await fixture.root.submit({ type: 'input', content: 'Ask then reopen elsewhere' }, context);
    const [question] = await pending;
    await fixture.harness.close(context);
    fixture.install(createNonInteractiveQuestionsExtension());
    await fixture.reopen(await openNodeSqliteStorage(database));
    const resumed = (await fixture.harness.submission(submission.id, context))!.wait(context);
    await expect.poll(async () => (await fixture.harness.getTask(question!.taskId, context))?.state.status).toBe('running');
    expect(await listQuestions(fixture.harness, fixture.root.id, context)).toEqual([question]);
    expect(fixture.faux.state.callCount).toBe(1);
    await answerQuestion(fixture.harness, fixture.root.id, question!.id, 'Answered through a supported host API', context);
    expect((await resumed).status).toBe('done');
    expect(fixture.faux.state.callCount).toBe(2);
  });
});
