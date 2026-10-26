import { defineExtension, wrapTool, type ToolRegistration } from '@earendil-works/pi-durable';

/** Abort-aware, FIFO admission. It bounds active execution, rather than creating another scheduler. */
export class Semaphore {
  #active = 0;
  #queue: Array<{ grant: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }> = [];
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Semaphore capacity must be a positive integer');
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#active < this.capacity) this.#active++;
    else await new Promise<void>((resolve, reject) => {
      const item = {
        grant: resolve, reject, signal,
        abort: () => { this.#queue = this.#queue.filter((queued) => queued !== item); reject(signal?.reason ?? new Error('Cancelled')); },
      };
      this.#queue.push(item);
      signal?.addEventListener('abort', item.abort, { once: true });
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) { next.signal?.removeEventListener('abort', next.abort); next.grant(); }
      else this.#active--;
    };
  }
}

/** Waiting orchestration tools own independent admission; they must not hold execution permits. */
export function createConcurrencyExtension(tools: readonly ToolRegistration[], capacity: number) {
  const semaphore = new Semaphore(capacity);
  return defineExtension({
    name: 'morphess.execution-bounds',
    wraps: [...new Map(tools.map((tool) => [tool.name, tool])).values()]
      .filter((tool) => !['delegate', 'codemode', 'ask_user'].includes(tool.name))
      .map((tool) => wrapTool(tool, (resolved) => ({
        ...resolved,
        executionMode: ['bash', 'write', 'edit'].includes(resolved.name) ? 'sequential' : resolved.executionMode,
        execute: async (args, api, context) => {
          const release = await semaphore.acquire(context.abortSignal);
          try { context.abortSignal?.throwIfAborted(); return await resolved.execute(args, api, context); }
          finally { release(); }
        },
      }))),
  });
}
