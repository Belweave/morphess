import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { CostLedgerDoc } from '../src/runtime/budgets.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(ceiling: number, knownUsage = false) {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-cost-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = defaultConfig(directory); config.model.cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }; config.limits.maxSpendUsd = ceiling;
  const faux = fauxProvider();
  const model = { ...faux.provider.getModels()[0]!, contextWindow: 1_000_000, maxTokens: 32_768, cost: config.model.cost };
  const models = createModels(); models.setProvider({ ...faux.provider, getModels: () => [model], streamSimple(target, transcript, options) {
    const stream = new AssistantMessageEventStream();
    void (async () => {
      const source = faux.provider.streamSimple(target, transcript, options);
      for await (const event of source) {
        if (event.type === 'done') {
          const usage = knownUsage
            ? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.000001, output: 0.000001, cacheRead: 0, cacheWrite: 0, total: 0.000002 } }
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          stream.push({ ...event, message: { ...event.message, usage } });
        } else stream.push(event);
      }
      stream.end();
    })();
    return stream;
  } });
  const runtime = await MorphessRuntime.open(config, { models }); cleanup.push(() => runtime.close());
  return { runtime, faux };
}

it('rejects insufficient worst-case request capacity before network dispatch', async () => {
  const { runtime, faux } = await setup(0.5);
  const submission = await runtime.submit({ type: 'input', content: 'Expensive work' });
  expect((await runtime.answer(submission.id)).submission.status).toBe('unanswered');
  expect(faux.state.callCount).toBe(0);
});

it('atomically reserves concurrent requests and retains unknown charges', async () => {
  const { runtime, faux } = await setup(1.1);
  faux.setResponses([async () => { await new Promise(resolve => setTimeout(resolve, 60)); return fauxAssistantMessage('usage not reported'); }]);
  const other = await runtime.createConversation();
  const submissions = await Promise.all([
    runtime.submit({ type: 'input', content: 'First' }),
    other.submit({ type: 'input', content: 'Second' }, BACKGROUND_CONTEXT),
  ]);
  const answers = await Promise.all(submissions.map(submission => runtime.answer(submission.id)));
  expect(answers.filter(answer => answer.submission.status === 'done')).toHaveLength(1);
  expect(faux.state.callCount).toBe(1);
  const ledger = await runtime.harness.snapshot(CostLedgerDoc, BACKGROUND_CONTEXT);
  expect(ledger?.reservedMicros).toBe(1_032_768);
});

it('settles confirmed usage before allowing another model request', async () => {
  const { runtime, faux } = await setup(1.1, true);
  faux.setResponses([fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
  for (const content of ['First', 'Second']) {
    const submission = await runtime.submit({ type: 'input', content });
    expect((await runtime.answer(submission.id)).submission.status).toBe('done');
  }
  const ledger = await runtime.harness.snapshot(CostLedgerDoc, BACKGROUND_CONTEXT);
  expect(ledger).toEqual({ chargedMicros: 4, reservedMicros: 0 });
});
