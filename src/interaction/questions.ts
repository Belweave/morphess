import { Type } from '@earendil-works/pi-ai';
import { copyJson } from '@earendil-works/chord';
import { awaitWithContext, withAbortSignal, withoutAbortSignal, type Context } from '@earendil-works/chord/context';
import {
  defineDoc, defineExtension, defineTool,
  type ConversationId, type Extension, type Harness, type TaskId,
} from '@earendil-works/pi-durable';

export type UserQuestion = {
  /** Exact owning Pi tool task ID, also used as the stable question ID. */
  id: number;
  taskId: TaskId;
  conversationId: ConversationId;
  question: string;
  options: string[];
  createdAt: number;
  deadline?: number;
  status: 'pending' | 'answered' | 'cancelled' | 'expired';
  answer?: string;
};

/** UI-safe durable state: user-visible question data only, never host credentials or handles. */
export const QuestionsDoc = defineDoc<{ questions: Record<string, UserQuestion> }>({
  kind: 'morphess.questions', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ questions: {} }), checkpointWhen: () => false,
});

function checkAnswer(answer: string): void {
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 50_000)
    throw new Error('Answer must contain 1–50000 characters and cannot be blank');
}

/**
 * Pending, live questions only. Creates the empty document so a UI can acquire a native
 * QuestionsDoc watch immediately afterwards. Cancellation marks and expired deadlines
 * are checked against owner task records, including before their invocation resumes.
 */
export async function listQuestions(harness: Harness, conversationId: ConversationId, context: Context): Promise<UserQuestion[]> {
  return harness.commit(async tx => {
    if (!await tx.conversation(conversationId)) throw new Error('Conversation not found');
    const state = await tx.doc(QuestionsDoc, conversationId);
    const pending: UserQuestion[] = [];
    for (const question of Object.values(state.questions)) {
      if (question.status !== 'pending' || (question.deadline !== undefined && question.deadline <= Date.now())) continue;
      const owner = await tx.task(question.taskId);
      if (!owner || owner.conversationId !== conversationId || owner.abortRequested || ['terminal', 'completing'].includes(owner.state.status)) continue;
      pending.push(copyJson(question) as UserQuestion);
    }
    return pending.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }, context);
}

/** Freeform answers are accepted even when suggestions were supplied. Same-answer retries are idempotent. */
export async function answerQuestion(
  harness: Harness, conversationId: ConversationId, questionId: number, answer: string, context: Context,
): Promise<UserQuestion> {
  checkAnswer(answer);
  if (!Number.isSafeInteger(questionId) || questionId < 1) throw new Error('Question ID must be a positive safe integer');
  return harness.commit(async tx => {
    if (!await tx.conversation(conversationId)) throw new Error('Conversation not found');
    const state = await tx.doc(QuestionsDoc, conversationId);
    const question = state.questions[String(questionId)];
    if (!question || question.id !== questionId || question.conversationId !== conversationId) throw new Error('Question not found');
    if (question.status === 'answered') {
      if (question.answer !== answer) throw new Error('Question was already answered differently');
      return copyJson(question) as UserQuestion;
    }
    if (question.status !== 'pending') throw new Error(`Question is ${question.status}`);
    if (question.deadline !== undefined && question.deadline <= Date.now()) throw new Error('Question has expired');
    const owner = await tx.task(question.taskId);
    if (!owner || owner.conversationId !== conversationId || owner.abortRequested || ['terminal', 'completing'].includes(owner.state.status))
      throw new Error('Question is no longer pending');
    question.answer = answer;
    question.status = 'answered';
    return copyJson(question) as UserQuestion;
  }, context);
}

/**
 * Human input is a durable native tool wait, not a second agent loop or an approval bypass.
 * Replay-safe: the question key is the owning Pi task ID and answered values remain durable.
 * A host close stops the observer but preserves pending work; an explicit task abort cancels it.
 */
export function createQuestionsExtension(options: { getHarness: () => Harness }): Extension {
  return defineExtension({
    name: 'morphess-questions',
    tools: [defineTool({
      name: 'ask_user',
      description: 'Ask the user a question when their answer materially affects the task. Optional choices are suggestions; a freeform answer is allowed. Waits for the actual answer. This does not grant tool permissions.',
      parameters: Type.Object({
        question: Type.String({ minLength: 1, maxLength: 10_000 }),
        options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 2, maxItems: 8, uniqueItems: true })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 3_600_000 })),
      }, { additionalProperties: false }),
      replay: 'safe',
      outputLimits: { maxBytes: 200_000, maxLines: 50_001 },
      execute: async (args, api, context) => {
        if (!args.question.trim()) throw new Error('Question cannot be blank');
        const choices = (args.options ?? []).map(option => option.trim());
        if (choices.some(option => !option) || new Set(choices).size !== choices.length)
          throw new Error('Question options must be nonblank and distinct');
        const harness = options.getHarness();
        let closing = false;
        const stopClose = harness.subscribeClose(() => { closing = true; });
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const key = String(api.taskId);
        try {
          const question = await api.commit(async tx => {
            const state = await tx.doc(QuestionsDoc, api.conversationId);
            const existing = state.questions[key];
            if (existing) {
              if (existing.question !== args.question || JSON.stringify(existing.options) !== JSON.stringify(choices))
                throw new Error('Question task was already recorded with different arguments');
              return copyJson(existing) as UserQuestion;
            }
            const entries = Object.values(state.questions);
            // Bound persisted history, but never delete a live answer before its task result commits.
            if (entries.length >= 256) {
              for (const prior of entries.sort((a, b) => a.createdAt - b.createdAt)) {
                const owner = await tx.task(prior.taskId);
                if (!owner || owner.state.status === 'terminal') delete state.questions[String(prior.id)];
                if (Object.keys(state.questions).length < 256) break;
              }
              if (Object.keys(state.questions).length >= 256) throw new Error('Too many live user questions');
            }
            let pending = 0;
            for (const prior of Object.values(state.questions)) {
              if (prior.status !== 'pending') continue;
              const owner = await tx.task(prior.taskId);
              if (owner && !owner.abortRequested && !['terminal', 'completing'].includes(owner.state.status)) pending++;
            }
            if (pending >= 16) throw new Error('At most 16 user questions may be pending per conversation');
            const created: UserQuestion = {
              id: api.taskId, taskId: api.taskId, conversationId: api.conversationId,
              question: args.question, options: choices, createdAt: api.now(), status: 'pending',
              ...(args.timeoutMs === undefined ? {} : { deadline: api.now() + args.timeoutMs }),
            };
            state.questions[key] = created;
            return created;
          }, context);
          await api.details({ questionId: question.id, taskId: api.taskId, conversationId: api.conversationId }, context);
          if (question.status === 'answered') return { output: [{ type: 'text', text: question.answer! }] };
          if (question.status !== 'pending') throw new Error(`Question is ${question.status}`);
          if (question.deadline !== undefined) {
            const remaining = question.deadline - api.now();
            if (remaining <= 0) controller.abort(new Error('User question timed out'));
            else {
              timer = setTimeout(() => controller.abort(new Error('User question timed out')), remaining);
              timer.unref();
            }
          }
          const waiting = withAbortSignal(controller.signal, context);
          waiting.abortSignal?.throwIfAborted();
          const watch = await api.watchDoc(QuestionsDoc, api.conversationId, waiting);
          if (!watch) throw new Error('Question document was removed');
          try {
            const answer = await awaitWithContext(new Promise<string>((resolve, reject) => {
              const inspect = (value: typeof watch.value) => {
                const current = value?.questions[key];
                if (!current) reject(new Error('Question was removed'));
                else if (current.status === 'answered') resolve(current.answer!);
                else if (current.status !== 'pending') reject(new Error(`Question is ${current.status}`));
              };
              watch.start(async value => { inspect(value); });
              inspect(watch.value);
              void watch.closed.then(end => reject(new Error(`Question observer ended: ${end.reason}`)));
            }), waiting);
            return { output: [{ type: 'text', text: answer }] };
          } finally { await watch.stop(); }
        } catch (error) {
          // The invocation API is invalid after cancellation. The host Session can still record
          // cancellation, but a closing host must leave the question resumable.
          if (!closing && (controller.signal.aborted || context.abortSignal?.aborted)) {
            const persistedAnswer = await harness.commit(async tx => {
              const question = (await tx.doc(QuestionsDoc, api.conversationId)).questions[key];
              // A timely answer may commit just before the timer fires, with its watch delivery
              // still queued. Commit order wins that race; do not discard accepted human input.
              if (question?.status === 'answered') return question.answer;
              if (question?.status === 'pending') question.status = controller.signal.aborted ? 'expired' : 'cancelled';
              return undefined;
            }, withoutAbortSignal(context)).catch(() => undefined);
            if (persistedAnswer !== undefined && !context.abortSignal?.aborted)
              return { output: [{ type: 'text', text: persistedAnswer }] };
          }
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
          stopClose();
        }
      },
    })],
  });
}
