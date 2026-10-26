import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { defaultConfig } from '../src/config.js';
import { MorphessRuntime } from '../src/runtime/runtime.js';
import { WorkDoc } from '../src/workflow/work.js';

it('runs bounded QuickJS code mode through native nested tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-code-'));
  const config = defaultConfig(directory); config.codemode = true;
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'const saved = await tools.remember({key:"codemode",note:"Nested calls are durable"}); text(saved);' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Code mode completed.'),
  ]);
  const runtime = await MorphessRuntime.open(config, { models });
  try {
    const submission = await runtime.submit({ type: 'input', content: 'Save a note through code mode' });
    expect((await runtime.answer(submission.id)).text).toBe('Code mode completed.');
    expect((await runtime.harness.snapshot(WorkDoc, runtime.root.id, BACKGROUND_CONTEXT))?.notes.codemode).toBe('Nested calls are durable');
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
