import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Message } from '@earendil-works/pi-ai';
import { configure, defineDocFamily, type ConversationId } from '@earendil-works/pi-durable';
import type { MorphessRuntime } from '../runtime/runtime.js';

const ChatRequestDoc = defineDocFamily<{ fingerprint: string; conversationId: number | null }, null>({
  kind: 'morphess.gateway-request', version: 1, scope: 'session', family: true,
  initial: () => ({ fingerprint: '', conversationId: null }), checkpointWhen: () => false,
});

/** Reserve the conversation and its imported history in one commit, before any agent effect can run. */
export async function acquireChatConversation(runtime: MorphessRuntime, options: {
  key?: string; fingerprint: string; conversationId?: string | number; instructions?: string; history: Message[];
}) {
  const key = options.key ?? randomUUID();
  if (key.length > 256 || key.length === 0) throw new Error('Idempotency-Key must contain 1–256 characters');
  const digest = createHash('sha256').update(key).digest('hex');
  const rootAgent = await runtime.root.agent(BACKGROUND_CONTEXT);
  const existing = options.conversationId === undefined ? undefined : await runtime.conversation(options.conversationId);
  const id = await runtime.harness.commit(async (tx) => {
    const request = await tx.doc(ChatRequestDoc, digest, null);
    if (request.conversationId !== null) {
      if (request.fingerprint !== options.fingerprint) throw new Error('Idempotency-Key already used for a different request');
      return request.conversationId as ConversationId;
    }
    const conversationId = existing?.id ?? (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id;
    if (!existing) {
      await configure(tx, conversationId, { model: rootAgent.model, cwd: runtime.config.workspace, instructions: options.instructions });
      for (const message of options.history) await tx.appendEntry(conversationId, { kind: 'morphess.import', model: [message] });
    }
    request.fingerprint = options.fingerprint;
    request.conversationId = conversationId;
    return conversationId;
  }, BACKGROUND_CONTEXT);
  return { conversation: await runtime.conversation(id), requestId: `gateway:${digest}` };
}
