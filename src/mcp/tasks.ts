import { createHash, randomUUID } from 'node:crypto';
import { defineDocFamily, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { CallToolResult, Transport } from '@modelcontextprotocol/client';
import { CreateTaskResultV2Schema, type CreateTaskResultV2 } from '@modelcontextprotocol/ext-tasks/core/v2';

/** Task handles are data, not a promise to repeat an interrupted external request. */
export const McpTaskDoc = defineDocFamily<{ server: string; taskId: string; handle: string }, null>({
  kind: 'morphess.mcp.task', version: 1, scope: 'session', family: true,
  initial: () => ({ server: '', taskId: '', handle: '' }), checkpointWhen: () => false,
});

/**
 * Official SDK2.4 deliberately rejects extension resultType:'task'. Lift only a
 * validated official Tasks result into an invocation-local opaque token before
 * its core decoder runs. No requests are retried and no wire bytes are changed.
 */
export class McpTaskBridge {
  readonly #handles = new Map<string, CreateTaskResultV2>();
  readonly #restore: () => void;
  constructor(transport: Transport) {
    const previous = transport.onmessage;
    const previousSend = transport.send;
    const toolRequests = new Set<string | number>();
    transport.send = async (message, options) => {
      if ('method' in message && 'id' in message && message.method === 'tools/call') {
        if (toolRequests.size >= 256) toolRequests.delete(toolRequests.values().next().value!);
        toolRequests.add(message.id);
      }
      try { await previousSend.call(transport, message, options); }
      catch (error) { if ('id' in message && message.id !== undefined) toolRequests.delete(message.id); throw error; }
    };
    transport.onmessage = (message, extra) => {
      const toolResponse = 'id' in message && message.id !== undefined && !('method' in message) && toolRequests.delete(message.id);
      if (toolResponse && 'result' in message && message.result && typeof message.result === 'object' && message.result.resultType === 'task') {
        const parsed = CreateTaskResultV2Schema.safeParse(message.result);
        if (parsed.success) {
          const nonce = randomUUID();
          if (this.#handles.size >= 64) this.#handles.delete(this.#handles.keys().next().value!);
          this.#handles.set(nonce, parsed.data);
          previous?.({ ...message, result: { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'External task created; inspect its durable handle.' }], _meta: { 'com.belweave/mcpTask': nonce } } }, extra);
          return;
        }
      }
      previous?.(message, extra);
    };
    this.#restore = () => { transport.onmessage = previous; transport.send = previousSend; toolRequests.clear(); this.#handles.clear(); };
  }
  take(result: CallToolResult): CreateTaskResultV2 | undefined {
    const nonce = result._meta?.['com.belweave/mcpTask'];
    if (typeof nonce !== 'string') return undefined;
    const task = this.#handles.get(nonce);
    this.#handles.delete(nonce);
    return task;
  }
  close(): void { this.#restore(); }
}

export async function retainTask(api: ToolExecutionApi | undefined, server: string, handle: CreateTaskResultV2, context: Context): Promise<void> {
  if (!api) throw new Error('MCP task creation requires a durable tool invocation to retain its handle');
  const key = createHash('sha256').update(JSON.stringify([server, handle.taskId])).digest('hex');
  await api.commit(async tx => {
    const record = await tx.doc(McpTaskDoc, key, null);
    record.server = server; record.taskId = handle.taskId; record.handle = JSON.stringify(handle);
  }, context);
}
