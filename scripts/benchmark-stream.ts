import { raceWithAbortSignal } from '@earendil-works/pi-ai/utils/abort';

// Run: node --expose-gc --import tsx scripts/benchmark-stream.ts [events]
// Synthetic fulfilled operations isolate retained abort bookkeeping from network/SDK costs.
const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (!collect) throw new Error('Run this benchmark with node --expose-gc --import tsx');
const events = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(events) || events < 1 || events > 1_000_000) throw new Error('Event count must be an integer from 1 to 1000000');
const controller = new AbortController();
let rejectAbort!: (reason: unknown) => void;
const pending = new Promise<never>((_, reject) => { rejectAbort = reject; });
collect();
const before = process.memoryUsage().heapUsed;
const started = performance.now();
for (let index = 0; index < events; index++) await Promise.race([Promise.resolve(index), pending]);
collect();
const sharedAbortPromise = { retainedHeapBytes: process.memoryUsage().heapUsed - before, elapsedMs: Math.round(performance.now() - started) };
rejectAbort(new Error('Benchmark finished'));
await new Promise<void>(resolve => setImmediate(resolve));
collect();
const cleanupBefore = process.memoryUsage().heapUsed;
const cleanupStarted = performance.now();
for (let index = 0; index < events; index++) await raceWithAbortSignal(Promise.resolve(index), controller.signal);
collect();
const cleanupAwareRace = { retainedHeapBytes: process.memoryUsage().heapUsed - cleanupBefore, elapsedMs: Math.round(performance.now() - cleanupStarted) };
process.stdout.write(`${JSON.stringify({ node: process.version, events, sharedAbortPromise, cleanupAwareRace }, null, 2)}\n`);
