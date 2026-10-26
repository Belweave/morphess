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

it('excludes blocked shell from both native model calls and the code mode namespace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-code-policy-'));
  const config = defaultConfig(directory);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'text("bash" in tools);' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Inspected available code tools.'),
  ]);
  const runtime = await MorphessRuntime.open(config, { models });
  try {
    const agent = await runtime.root.agent(BACKGROUND_CONTEXT);
    expect(agent.tools.some(tool => tool.name === 'bash')).toBe(false); expect(agent.callable.some(tool => tool.name === 'bash')).toBe(false);
    const submission = await runtime.submit({ type: 'input', content: 'Inspect code mode capabilities' });
    await runtime.answer(submission.id);
    const entries = await runtime.root.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
    const output = JSON.stringify(entries.items.filter(entry => entry.kind === 'pi.tool-result'));
    expect(output).toContain('false'); expect(output).toContain('Script completed');
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

it('offers and executes shell only in an explicitly trusted host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-code-trusted-')); const config = defaultConfig(directory); config.policy.mode = 'trusted';
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode', { code: 'text(await tools.bash({command:"printf permission-ok"}));' }), { stopReason: 'toolUse' }), fauxAssistantMessage('Trusted command completed.')]);
  const runtime = await MorphessRuntime.open(config, { models });
  try {
    expect((await runtime.root.agent(BACKGROUND_CONTEXT)).tools.some(tool => tool.name === 'bash')).toBe(true);
    const submission = await runtime.submit({ type: 'input', content: 'Run the bounded fixture command' });
    expect((await runtime.answer(submission.id)).text).toBe('Trusted command completed.');
    const entries = await runtime.root.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries.items.filter(entry => entry.kind === 'pi.tool-result'))).toContain('permission-ok');
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
