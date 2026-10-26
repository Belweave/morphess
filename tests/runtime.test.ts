import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { RunBudgetDoc } from '../src/runtime/budgets.js';
import { WorkDoc } from '../src/workflow/work.js';
import { Semaphore } from '../src/runtime/concurrency.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-runtime-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  return { directory, faux, models, config: defaultConfig(directory) };
}

it('runs real coding tools, saves to SQLite, reopens, and deduplicates submissions', async () => {
  const { directory, faux, models, config } = await setup();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write', { path: 'answer.txt', content: 'durable answer\n' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Saved and verified.'),
  ]);
  let runtime = await MorphessRuntime.open(config, { models });
  cleanup.push(() => runtime.close());
  const submission = await runtime.submit({ type: 'input', content: 'Write the answer', requestId: 'durable-input' });
  expect((await runtime.answer(submission.id)).text).toBe('Saved and verified.');
  expect(await readFile(join(directory, 'answer.txt'), 'utf8')).toBe('durable answer\n');
  await runtime.close();
  runtime = await MorphessRuntime.open(config, { models });
  expect((await runtime.submit({ type: 'input', content: 'Write the answer', requestId: 'durable-input' })).id).toBe(submission.id);
  expect((await runtime.answer(submission.id)).text).toBe('Saved and verified.');
  expect(faux.state.callCount).toBe(2);
});

it('enforces persisted request limits before dispatch, then grants a fresh user run', async () => {
  const { faux, models, config } = await setup(); config.limits.maxTurns = 1;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('remember', { key: 'decision', note: 'Persist evidence' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Fresh run'),
  ]);
  const runtime = await MorphessRuntime.open(config, { models }); cleanup.push(() => runtime.close());
  const first = await runtime.submit({ type: 'input', content: 'Loop forever' });
  expect((await runtime.answer(first.id)).submission.status).toBe('unanswered');
  expect(faux.state.callCount).toBe(1);
  const budget = await runtime.harness.snapshot(RunBudgetDoc, runtime.root.id, context);
  expect(budget?.requests).toBe(1);
  const next = await runtime.submit({ type: 'input', content: 'New task' });
  expect((await runtime.answer(next.id)).text).toBe('Fresh run');
});

it('keeps plans and notes across restart and forks as of the requested entry', async () => {
  const { faux, models, config } = await setup();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('remember', { key: 'architecture', note: 'Use Pi Durable' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Noted'),
  ]);
  const runtime = await MorphessRuntime.open(config, { models }); cleanup.push(() => runtime.close());
  const input = await runtime.submit({ type: 'input', content: 'Remember the design' });
  const answer = await runtime.answer(input.id);
  const fork = await runtime.fork(runtime.root.id, answer.entry!.id);
  expect((await runtime.harness.snapshot(WorkDoc, fork.id, context))?.notes.architecture).toBe('Use Pi Durable');
  expect((await runtime.contextBudget(fork.id)).contextWindow).toBe(1_000_000);
});

it('refuses competing writers and releases the lock on clean close', async () => {
  const { models, config } = await setup();
  const first = await MorphessRuntime.open(config, { models }); cleanup.push(() => first.close());
  await expect(MorphessRuntime.open(config, { models })).rejects.toThrow(/lock/i);
  await first.close();
  const next = await MorphessRuntime.open(config, { models }); cleanup.push(() => next.close());
  expect(next.root.id).toBe(first.root.id);
});

it('bounds parallel tool execution while allowing independent work', async () => {
  const { faux, models, config } = await setup(); config.limits.maxConcurrentAgents = 2;
  let active = 0; let peak = 0;
  const extension = defineExtension({ name: 'test-concurrency', tools: [defineTool({
    name: 'bounded_probe', parameters: Type.Object({}), description: 'probe', replay: 'safe',
    execute: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return { output: [] }; },
  })] });
  faux.setResponses([fauxAssistantMessage(Array.from({ length: 6 }, (_, index) => fauxToolCall('bounded_probe', {}, { id: `p${index}` })), { stopReason: 'toolUse' }), fauxAssistantMessage('complete')]);
  const runtime = await MorphessRuntime.open(config, { models, extensions: [extension] }); cleanup.push(() => runtime.close());
  const submission = await runtime.submit({ type: 'input', content: 'Parallelize' });
  expect((await runtime.answer(submission.id)).text).toBe('complete');
  expect(peak).toBe(2);
});

it('cancels queued semaphore work without leaking capacity', async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const waiting = semaphore.acquire(controller.signal);
  controller.abort(new Error('cancel queue'));
  await expect(waiting).rejects.toThrow('cancel queue');
  release();
  const next = await semaphore.acquire(); next(); next();
});
