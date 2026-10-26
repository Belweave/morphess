import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';

it('recovers SQLite after SIGKILL without repeating an uncertain external side effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-sigkill-'));
  const child = fork(fileURLToPath(new URL('./fixtures/crash-runner.ts', import.meta.url)), [directory], { execArgv: ['--import', 'tsx'], silent: true });
  let diagnostics = ''; child.stderr?.on('data', (data) => { diagnostics += data.toString(); });
  let submissionId: number | undefined;
  let runtime: MorphessRuntime | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child did not reach side effect: ${diagnostics}`)), 10_000);
      child.on('message', (message: { type: string; id?: number }) => {
        if (message.type === 'submission') submissionId = message.id;
        if (message.type === 'effect') { clearTimeout(timer); resolve(); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${diagnostics}`)); });
    });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    // Test lock timeout is deliberately short. Production defaults to 120 seconds.
    // The lock library can round its mtime up to the next whole second.
    await new Promise(resolve => setTimeout(resolve, 6_150));
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    let repeated = 0;
    const extension = defineExtension({ name: 'crash-fixture', tools: [defineTool({ name: 'external_effect', description: 'effect', parameters: Type.Object({}), replay: 'unsafe', execute: async () => { repeated++; return { output: [] }; } })] });
    faux.setResponses([fauxAssistantMessage('Recovered; the interrupted effect requires inspection.')]);
    runtime = await MorphessRuntime.open(defaultConfig(directory), { models, extensions: [extension], writerLock: { staleMs: 5_000, updateMs: 1_000 } });
    const answer = await runtime.answer(submissionId!);
    expect(answer.submission.status).toBe('done');
    expect(repeated).toBe(0);
    expect(await readFile(join(directory, 'effects.txt'), 'utf8')).toBe('effect\n');
    const entries = await runtime.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries.items)).toContain('interrupted');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
