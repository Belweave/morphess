import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { defaultConfig } from '../../src/config.js';
import { MorphessRuntime } from '../../src/runtime/runtime.js';

const workspace = process.argv[2]!;
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const extension = defineExtension({ name: 'crash-fixture', tools: [defineTool({
  name: 'external_effect', description: 'Perform an external effect', parameters: Type.Object({}), replay: 'unsafe',
  execute: async (_args, _api, context) => {
    await appendFile(join(workspace, 'effects.txt'), 'effect\n');
    process.send?.({ type: 'effect' });
    await new Promise<void>((resolve) => context.abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
    return { output: [] };
  },
})] });
faux.setResponses([fauxAssistantMessage(fauxToolCall('external_effect', {}), { stopReason: 'toolUse' })]);
const runtime = await MorphessRuntime.open(defaultConfig(workspace), { models, extensions: [extension], writerLock: { staleMs: 5_000, updateMs: 1_000 } });
const submission = await runtime.submit({ type: 'input', content: 'Run the external effect', requestId: 'crash-run' });
process.send?.({ type: 'submission', id: submission.id });
await runtime.answer(submission.id);
await runtime.close();
