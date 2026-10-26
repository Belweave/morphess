import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defaultConfig } from '../config.js';
import { MorphessRuntime } from '../runtime/runtime.js';

/** A real durable runtime in a temporary workspace with a scripted, offline provider. */
export async function openDemoRuntime(): Promise<{ runtime: MorphessRuntime; close(): Promise<void> }> {
  const workspace = await mkdtemp(join(tmpdir(), 'morphess-demo-'));
  try {
    await writeFile(join(workspace, 'README.md'), '# Morphess demo\n\nThis temporary workspace uses an offline scripted provider.\n');
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('read', { path: 'README.md' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('ask_user', { question: 'What should this demo focus on?', options: ['Review the workspace', 'Explain durable recovery'] }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('## Ready to build\n\nI read **README.md** using the real file tool and received your answer through a durable question.\n\n- Press **Ctrl+T** to inspect tool activity.\n- Use **/plan** to restrict tools while planning.\n- Press **Ctrl+O** to switch sessions without losing a draft.\n\nThis is a scripted offline demo; no inference endpoint was called.'),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const config = defaultConfig(workspace); config.model.id = 'offline-demo'; config.codemode = false;
    const runtime = await MorphessRuntime.open(config, { models });
    return { runtime, close: async () => { try { await runtime.close(); } finally { await rm(workspace, { recursive: true, force: true }); } } };
  } catch (error) { await rm(workspace, { recursive: true, force: true }); throw error; }
}
