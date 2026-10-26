import { Type } from '@earendil-works/pi-ai';
import { withAbortSignal, withoutAbortSignal } from '@earendil-works/chord/context';
import {
  AssistantEntry, configure, defineDoc, defineExtension, defineTool,
  type Extension, type TaskId,
} from '@earendil-works/pi-durable';

/** Session-wide admission is persisted, so recovery cannot forget occupied slots. */
const Slots = defineDoc<{ tasks: TaskId[] }>({
  kind: 'morphess.delegation.slots', version: 1, scope: 'session',
  initial: () => ({ tasks: [] }), checkpointWhen: () => false,
});

// Positive allowlist: unknown plugin tools, shell, code mode and MCP never become read-only by assertion.
const READ_ONLY_TOOLS = new Set(['read', 'ls', 'find', 'grep', 'search', 'glob', 'list_files', 'read_instructions', 'load_skill', 'git_status', 'git_diff']);

/**
 * Foreground children are Pi conversations owned by their invoking durable tool task.
 * Replay is safe because creation looks up ownership and submission uses a stable requestId.
 * Children deliberately cannot delegate: maxAgentDepth is an upper bound, currently capped at one.
 * This is cooperative tool restriction, not a sandbox for trusted extension code.
 */
export function createDelegationExtension(options: {
  maxConcurrentAgents: number;
  maxAgentDepth: number;
}): Extension {
  if (!Number.isInteger(options.maxConcurrentAgents) || options.maxConcurrentAgents < 1)
    throw new Error('maxConcurrentAgents must be a positive integer');
  if (!Number.isInteger(options.maxAgentDepth) || options.maxAgentDepth < 0)
    throw new Error('maxAgentDepth must be a nonnegative integer');
  const extension: Extension = defineExtension({
    name: 'morphess-delegation',
    tools: options.maxAgentDepth === 0 ? [] : [defineTool({
      name: 'delegate',
      description: 'Delegate a self-contained task to a foreground child. Researcher/reviewer can only read; coder inherits your enabled tools. Returns conversationId and answer. Children cannot delegate.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 200_000 }),
        role: Type.Optional(Type.Union([Type.Literal('researcher'), Type.Literal('reviewer'), Type.Literal('coder')])),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3_600_000 })),
      }),
      replay: 'safe',
      execute: async (args, api, context) => {
        const role = args.role ?? 'researcher';
        const parent = await api.agent(context);
        const enabled = [...new Map([...parent.tools, ...parent.callable, ...parent.deferred]
          .map(tool => [tool.name, tool])).values()];
        const tools = enabled.filter(tool => tool.name !== 'delegate' &&
          (role === 'coder' || READ_ONLY_TOOLS.has(tool.name)));
        const deadline = await api.memo('morphess.delegate.deadline', api.now() + (args.timeoutMs ?? 600_000), context);
        const childId = await api.commit(async tx => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          const slots = await tx.doc(Slots);
          // A call can fail or be cancelled without reaching its finally after a process crash.
          const active: TaskId[] = [];
          for (const id of slots.tasks) {
            const record = await tx.task(id);
            if (record !== undefined && record.state.status !== 'terminal') active.push(id);
          }
          if (!active.includes(api.taskId)) {
            if (active.length >= options.maxConcurrentAgents) throw new Error('Delegation concurrency limit reached; wait for an active child to finish');
            active.push(api.taskId);
          }
          slots.tasks = active;
          if (existing !== undefined) return existing.id;
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
          await configure(tx, child.id, {
            extensions: { remove: [extension] },
            tools,
            instructions: [parent.instructions ?? '', `You are a ${role} child agent. Complete the assigned task and report evidence and limitations. You may not delegate further.`,
              role === 'coder' ? 'Coordinate file ownership with the parent.' : 'Read-only role: do not modify files or execute commands.'].join('\n'),
          });
          return child.id;
        }, context);
        const child = (await api.conversation(childId, context))!;
        await api.details({ conversationId: childId, role }, context);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Delegation timed out')), Math.max(0, deadline - api.now()));
        timer.unref();
        const childContext = withAbortSignal(controller.signal, context);
        try {
          childContext.abortSignal?.throwIfAborted();
          if (deadline <= api.now()) throw new Error('Delegation timed out');
          const submission = await child.submit({ type: 'input', content: args.task, requestId: `morphess.delegate:${api.taskId}` }, childContext);
          const settled = await submission.wait(childContext);
          if (settled.status !== 'done' || settled.type !== 'input') throw new Error(`Child ended without an answer: ${settled.status}`);
          const entry = await api.commit(tx => tx.entry(AssistantEntry, settled.answer), childContext);
          const message = entry?.model?.[0];
          const answer = message?.role === 'assistant' ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') : '';
          return {
            output: [{ type: 'text', text: JSON.stringify({ conversationId: childId, role, answer }) }],
            details: { conversationId: childId, role },
          };
        } catch (error) {
          // Timeout cancels the wait only, so explicitly stop the child. Parent cancellation is
          // handled by Pi ownership; Harness close must preserve its work for recovery.
          if (controller.signal.aborted && !context.abortSignal?.aborted)
            await child.abort(withoutAbortSignal(context)).catch(() => {});
          throw error;
        } finally {
          clearTimeout(timer);
          // Closing the Harness invalidates api; stale slots are pruned by the next admission.
          if (!context.abortSignal?.aborted) {
            await api.commit(async tx => {
              const slots = await tx.doc(Slots);
              slots.tasks = slots.tasks.filter(id => id !== api.taskId);
            }, withoutAbortSignal(context)).catch(() => {});
          }
        }
      },
    })],
  });
  return extension;
}
