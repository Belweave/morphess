import { expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { withBudget } from '../src/runtime/budgets.js';
import { Semaphore } from '../src/runtime/concurrency.js';

it('cancels queued model work without dispatch, admission, or consuming the next permit', async () => {
  let unblock!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { unblock = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const faux = fauxProvider();
  faux.setResponses([async () => { started(); await waiting; return fauxAssistantMessage('first'); }, fauxAssistantMessage('next')]);
  const source = createModels(); source.setProvider(faux.provider);
  const admit = vi.fn(async () => ({ settle: vi.fn(async () => {}) }));
  const models = withBudget(source, admit, 1);
  const transcript = { messages: [{ role: 'user' as const, content: 'work', timestamp: 1 }] };
  const first = models.completeSimple(faux.getModel(), transcript);
  await entered;
  const controller = new AbortController();
  const queued = models.completeSimple(faux.getModel(), transcript, { signal: controller.signal });
  controller.abort(new Error('Queued request cancelled'));
  const cancelled = await queued;
  expect(cancelled.stopReason).toBe('aborted');
  expect(cancelled.errorMessage).toContain('Queued request cancelled');
  expect(admit).toHaveBeenCalledTimes(1);
  unblock();
  expect((await first).stopReason).toBe('stop');
  expect((await models.completeSimple(faux.getModel(), transcript)).stopReason).toBe('stop');
  expect(admit).toHaveBeenCalledTimes(2);
  expect(faux.state.callCount).toBe(2);
});

it('releases an undispatched spend reservation when cancellation races durable admission', async () => {
  const faux = fauxProvider(); const source = createModels(); source.setProvider(faux.provider);
  const controller = new AbortController();
  const settle = vi.fn(async () => {});
  const models = withBudget(source, async () => { controller.abort(new Error('Cancelled during admission')); return { settle }; }, 1);
  const result = await models.completeSimple(faux.getModel(), { messages: [] }, { signal: controller.signal });
  expect(result.stopReason).toBe('aborted');
  expect(settle).toHaveBeenCalledWith(expect.objectContaining({ stopReason: 'aborted' }), true);
  expect(faux.state.callCount).toBe(0);
});

it('keeps semaphore admission FIFO after a queued cancellation and duplicate release', async () => {
  const semaphore = new Semaphore(1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const cancelled = semaphore.acquire(controller.signal).catch(error => error);
  const order: string[] = [];
  const second = semaphore.acquire().then(release => { order.push('second'); return release; });
  const third = semaphore.acquire().then(release => { order.push('third'); return release; });
  controller.abort(new Error('Cancelled'));
  expect(await cancelled).toBeInstanceOf(Error);
  release(); release();
  const releaseSecond = await second;
  expect(order).toEqual(['second']);
  releaseSecond();
  (await third)();
  expect(order).toEqual(['second', 'third']);
  (await semaphore.acquire())();
});
