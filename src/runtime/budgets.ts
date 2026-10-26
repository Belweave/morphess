import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { randomUUID } from 'node:crypto';
import type { Api, AssistantMessage, Model, Models } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import {
  defineDoc, defineDocFamily, LiveDoc, ProviderDoc, type ConversationId, type Cursor, type Harness,
} from '@earendil-works/pi-durable';
import { Semaphore } from './concurrency.js';

export const RunBudgetDoc = defineDoc<{ runKey: string; requests: number }>({
  kind: 'morphess.budget', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ runKey: '', requests: 0 }), checkpointWhen: () => false,
});

export class BudgetExceeded extends Error {
  override name = 'BudgetExceeded';
}

export const CostLedgerDoc = defineDoc<{ chargedMicros: number; reservedMicros: number }>({
  kind: 'morphess.cost-ledger', version: 1, scope: 'session',
  initial: () => ({ chargedMicros: 0, reservedMicros: 0 }), checkpointWhen: () => false,
});
const ReservationDoc = defineDocFamily<{ micros: number; settled: boolean }, null>({
  kind: 'morphess.cost-reservation', version: 1, scope: 'session', family: true,
  initial: () => ({ micros: 0, settled: false }), checkpointWhen: () => false,
});
interface Admission {
  settle(message: AssistantMessage, undispatched?: boolean): Promise<void>;
}
type Admit = (sessionId: string | undefined, model: Model<Api>) => Promise<Admission>;

/** Admission is persisted before dispatch. A crash can consume an extra reservation, never grant free work. */
export function createBudgetAdmission(
  getHarness: () => Harness,
  limits: { maxTurns: number; maxSpendUsd?: number },
): Admit {
  const identities = new Map<string, ConversationId>();
  return async (sessionId, model) => {
    if (!sessionId) throw new BudgetExceeded('Model dispatch requires a durable session identity.');
    const harness = getHarness();
    const reservationId = randomUUID();
    // Prices are dollars per million tokens. Reserving the whole configured window
    // bounds concurrent admission without pretending a text/image estimate is exact.
    const reserveMicros = Math.ceil(model.contextWindow * Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite) + model.maxTokens * model.cost.output);
    if (!Number.isSafeInteger(reserveMicros) || reserveMicros < 0) throw new BudgetExceeded('Invalid configured model prices or capacity');
    await harness.commit(async (tx) => {
      let conversationId = identities.get(sessionId);
      if (!conversationId) {
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanConversations({}, 128, cursor);
          for (const item of page.items) {
            const provider = await tx.doc(ProviderDoc, item.id);
            if (provider) identities.set(provider.sessionId, item.id);
          }
          conversationId = identities.get(sessionId);
          cursor = page.next;
        } while (!conversationId && cursor);
      }
      if (!conversationId) throw new BudgetExceeded('Unknown durable provider session.');
      const live = await tx.doc(LiveDoc, conversationId);
      const runKey = String(live?.run?.inputs[0] ?? live?.compactions?.at(-1)?.taskId ?? 'manual');
      const budget = await tx.doc(RunBudgetDoc, conversationId);
      if (budget.runKey !== runKey) { budget.runKey = runKey; budget.requests = 0; }
      if (budget.requests >= limits.maxTurns) {
        throw new BudgetExceeded(`Out of budget: maximum ${limits.maxTurns} model requests per run reached.`);
      }
      if (limits.maxSpendUsd !== undefined) {
        const ledger = await tx.doc(CostLedgerDoc);
        if (ledger.chargedMicros + ledger.reservedMicros + reserveMicros > Math.floor(limits.maxSpendUsd * 1_000_000)) {
          throw new BudgetExceeded('Out of budget: insufficient capacity for the worst-case model request.');
        }
        const reservation = await tx.doc(ReservationDoc, reservationId, null);
        reservation.micros = reserveMicros;
        ledger.reservedMicros += reserveMicros;
      }
      budget.requests += 1;
    }, BACKGROUND_CONTEXT);
    return {
      settle: async (message, undispatched = false) => {
        if (limits.maxSpendUsd === undefined) return;
        // Unknown billing after an error/crash remains reserved. Only confirmed
        // usage or proof that dispatch never happened can release the reservation.
        if (!undispatched && message.usage.totalTokens <= 0 && reserveMicros > 0) return;
        await harness.commit(async (tx) => {
          const reservation = await tx.doc(ReservationDoc, reservationId, null);
          if (reservation.settled) return;
          const ledger = await tx.doc(CostLedgerDoc);
          const charged = undispatched ? 0 : Math.ceil(message.usage.cost.total * 1_000_000);
          if (!Number.isSafeInteger(charged) || charged < 0) throw new Error('Invalid provider usage cost');
          ledger.reservedMicros = Math.max(0, ledger.reservedMicros - reservation.micros);
          ledger.chargedMicros += charged;
          reservation.settled = true;
        }, BACKGROUND_CONTEXT);
      },
    };
  };
}

function errorMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'error', errorMessage: error instanceof Error ? error.message : 'Model admission failed', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** Decorate model dispatch, leaving Pi's loop, retry classification, and checkpoints intact. */
export function withBudget(models: Models, admit: Admit, maxConcurrentRequests = 4): Models {
  const semaphore = new Semaphore(maxConcurrentRequests);
  const wrap = (method: 'stream' | 'streamSimple'): Models['streamSimple'] => (model, transcript, options) => {
    const stream = new AssistantMessageEventStream();
    void (async () => {
      let release: (() => void) | undefined;
      let admission: Admission | undefined;
      let dispatched = false;
      try {
        release = await semaphore.acquire(options?.signal);
        admission = await admit(options?.sessionId, model);
        if (options?.signal?.aborted) throw new Error('Model request cancelled before dispatch');
        dispatched = true;
        const source = models[method](model, transcript, options);
        let settled = false;
        for await (const event of source) {
          if (event.type === 'done' || event.type === 'error') {
            await admission.settle(event.type === 'done' ? event.message : event.error);
            settled = true;
          }
          stream.push(event);
        }
        const result = await source.result();
        if (!settled) await admission.settle(result);
        stream.end(result);
      } catch (error) {
        const message = errorMessage(model, error);
        if (admission && !dispatched) await admission.settle(message, true).catch(() => {});
        stream.push({ type: 'error', reason: 'error', error: message });
        stream.end(message);
      } finally { release?.(); }
    })();
    return stream;
  };
  const stream = wrap('stream');
  const streamSimple = wrap('streamSimple');
  return new Proxy(models, {
    get(target, property) {
      if (property === 'stream') return stream;
      if (property === 'streamSimple') return streamSimple;
      if (property === 'complete') return (...args: Parameters<Models['streamSimple']>) => stream(...args).result();
      if (property === 'completeSimple') return (...args: Parameters<Models['streamSimple']>) => streamSimple(...args).result();
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
