import { resolve } from 'node:path';
import { copyJson } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import {
  AgentDoc, AssistantEntry, LiveDoc, configure, defineDoc, watchEvents,
  type AgentEvent, type AgentEventStream, type Conversation, type ConversationId,
  type Cursor, type TaskId, type ToolRegistration,
} from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import type { MorphessRuntime } from '../runtime/runtime.js';
import { withImages } from '../media/input.js';
import { getProviderCredentialStatus, providerCredentialDirectory } from '../models/credentials.js';
import { QuestionsDoc, answerQuestion, listQuestions, type UserQuestion } from '../interaction/index.js';
import { WorkDoc } from '../workflow/work.js';
import { createWorkspaceEnvironment, type WorkspaceExecutionEnv } from '../policy/workspace.js';
import { listWorkspaceFiles } from '../tools/workspace.js';
import { sanitizeText, TuiProjection, type TuiSnapshot } from './state.js';

export const ConversationModeDoc = defineDoc<{ mode: 'build' | 'plan'; restore: string[] }>({
  kind: 'morphess.tui-mode', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ mode: 'build', restore: [] }), checkpointWhen: () => false,
});

const PLAN_TOOLS = new Set([
  'read', 'read_bytes', 'ls', 'find', 'grep', 'glob', 'search', 'list_files', 'read_instructions', 'load_skill',
  'git_status', 'git_diff', 'ask_user', 'update_plan', 'remember', 'delegate',
]);
type QuestionWatch = { stop(): Promise<unknown> };

/** UI controller only: Pi retains all execution, submission, ownership and recovery authority. */
export class TuiController {
  readonly runtime: MorphessRuntime;
  #env: WorkspaceExecutionEnv;
  #projection = new TuiProjection();
  #snapshot: TuiSnapshot;
  #conversation!: Conversation;
  #listeners = new Set<(snapshot: TuiSnapshot) => void>();
  #lifetime = new AbortController();
  #session = new AbortController();
  #epoch = 0;
  #switchRequest = 0;
  #events: AgentEventStream | undefined;
  #documents: QuestionWatch[] = [];
  #questionWatches = new Map<number, QuestionWatch>();
  #questionPending = new Set<string>();
  #questions = new Map<number, UserQuestion[]>();
  #children = new Map<string, { id: ConversationId; taskId?: TaskId }>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  private constructor(runtime: MorphessRuntime, env: WorkspaceExecutionEnv) {
    this.runtime = runtime; this.#env = env;
    this.#snapshot = { sessionId: runtime.root.id, workspace: sanitizeText(runtime.config.workspace, 4_096),
      model: sanitizeText(runtime.config.model.id, 500), policy: runtime.config.policy.mode, mode: 'build', busy: false,
      entries: [], questions: [], plan: [], usage: this.#projection.usage, status: 'Opening session', version: 0 };
  }

  static async open(runtime: MorphessRuntime, options: { sessionId?: string | number } = {}): Promise<TuiController> {
    const env = await createWorkspaceEnvironment({ workspace: runtime.config.workspace, mode: 'read-only',
      maxOutputBytes: 64_000, shellTimeoutMs: 10_000, protectedPaths: [runtime.config.stateDir, providerCredentialDirectory()] });
    const controller = new TuiController(runtime, env);
    try { await controller.switchSession(options.sessionId ?? runtime.root.id); return controller; }
    catch (error) { await controller.close(); throw error; }
  }

  get state(): TuiSnapshot { return this.#snapshot; }

  subscribe(listener: (snapshot: TuiSnapshot) => void): () => void {
    this.#listeners.add(listener); try { listener(this.#snapshot); } catch { /* Renderer-owned failure. */ }
    return () => { this.#listeners.delete(listener); };
  }

  #assertOpen(): void { if (this.#closed) throw new Error('TUI controller is closed'); }
  #valid(epoch: number): boolean { return !this.#closed && epoch === this.#epoch; }
  #context() { return withAbortSignal(AbortSignal.any([this.#lifetime.signal, this.#session.signal]), BACKGROUND_CONTEXT); }

  #publish(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#flush(); }, 40);
    this.#timer.unref();
  }

  #flush(): void {
    if (this.#closed) return;
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    const questions = [...this.#questions.values()].flat().map(question => ({ ...question,
      question: sanitizeText(question.question, 10_000), options: question.options.map(option => sanitizeText(option, 512)) }));
    this.#snapshot = { ...this.#snapshot, entries: this.#projection.entries, busy: this.#projection.busy,
      usage: this.#projection.usage, status: questions.length ? 'Waiting for your answer' : this.#projection.status,
      error: this.#projection.error, questions, version: this.#snapshot.version + 1 };
    for (const listener of this.#listeners) { try { listener(this.#snapshot); } catch { /* A renderer cannot terminate native work. */ } }
  }

  #fail(error: unknown, epoch = this.#epoch): void {
    if (!this.#valid(epoch)) return;
    this.#projection.error = sanitizeText(error instanceof Error ? error.message : String(error));
    this.#projection.status = 'Error'; this.#publish();
  }

  async #refreshContext(epoch: number): Promise<void> {
    if (!this.#valid(epoch)) return;
    try {
      const context = await this.runtime.contextBudget(this.#conversation.id);
      if (this.#valid(epoch)) { this.#snapshot = { ...this.#snapshot, context }; this.#publish(); }
    } catch (error) { if (this.#valid(epoch)) this.#fail(error, epoch); }
  }

  async #refreshQuestions(id: ConversationId, epoch: number): Promise<void> {
    if (!this.#valid(epoch)) return;
    const questions = await listQuestions(this.runtime.harness, id, this.#context());
    if (this.#valid(epoch) && (id === this.#conversation.id || [...this.#children.values()].some(child => child.id === id))) {
      this.#questions.set(id, questions); this.#publish();
    }
  }

  async #attachQuestions(id: ConversationId, epoch: number, taskId?: TaskId): Promise<void> {
    const pendingKey = `${epoch}:${id}`;
    if (!this.#valid(epoch) || this.#questionWatches.has(id) || this.#questionPending.has(pendingKey)) return;
    this.#questionPending.add(pendingKey);
    try {
      if (id !== this.#conversation.id) {
        const owned = await this.runtime.harness.commit(async tx => {
          const record = await tx.conversation(id);
          if (record?.owner?.conversationId !== this.#conversation.id || (taskId !== undefined && record.owner.taskId !== taskId)) return false;
          const owner = await tx.task(record.owner.taskId);
          return !!owner && !owner.abortRequested && owner.state.status !== 'terminal';
        }, this.#context());
        if (!owned) return;
      }
      await listQuestions(this.runtime.harness, id, this.#context());
      const watch = await this.runtime.harness.watchDoc(QuestionsDoc, id, this.#context());
      if (!watch) return;
      if (!this.#valid(epoch) || (id !== this.#conversation.id && ![...this.#children.values()].some(child => child.id === id))) { await watch.stop(); return; }
      this.#questionWatches.set(id, watch);
      watch.start(async () => { try { await this.#refreshQuestions(id, epoch); } catch (error) { this.#fail(error, epoch); } });
      await this.#refreshQuestions(id, epoch);
    } finally { this.#questionPending.delete(pendingKey); }
  }

  #child(callId: string, id: unknown, epoch: number, taskId?: TaskId): void {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id === this.#conversation.id) return;
    if (!this.#children.has(callId) && this.#children.size >= this.runtime.config.limits.maxConcurrentAgents) return;
    this.#children.set(callId, { id: id as ConversationId, ...(taskId === undefined ? {} : { taskId }) });
    void this.#attachQuestions(id as ConversationId, epoch, taskId).catch(error => this.#fail(error, epoch));
  }

  #removeChild(callId: string): void {
    const child = this.#children.get(callId); this.#children.delete(callId);
    if (!child || [...this.#children.values()].some(item => item.id === child.id)) return;
    const watch = this.#questionWatches.get(child.id); this.#questionWatches.delete(child.id); this.#questions.delete(child.id);
    if (watch) void watch.stop();
  }

  #observe(events: readonly AgentEvent[], epoch: number): void {
    if (!this.#valid(epoch)) return;
    this.#projection.apply(events);
    for (const event of events) {
      if (event.type === 'snapshot') {
        const tools = [...event.tools, ...event.nestedTools];
        const active = new Set(tools.filter(slot => slot.name === 'delegate' && slot.status !== 'done').map(slot => slot.callId));
        for (const callId of this.#children.keys()) if (!active.has(callId)) this.#removeChild(callId);
        for (const slot of tools) if (slot.name === 'delegate' && slot.status !== 'done' && slot.details && typeof slot.details === 'object' && 'conversationId' in slot.details)
          this.#child(slot.callId, slot.details.conversationId, epoch, slot.taskId);
      } else if (event.type === 'tool_execution_update' && event.toolName === 'delegate' && event.details && typeof event.details === 'object' && 'conversationId' in event.details) {
        this.#child(event.toolCallId, event.details.conversationId, epoch, event.taskId);
      } else if (event.type === 'tool_execution_end') this.#removeChild(event.toolCallId);
      else if (event.type === 'run_end') {
        for (const callId of this.#children.keys()) this.#removeChild(callId);
        void this.#refreshQuestions(this.#conversation.id, epoch).catch(error => this.#fail(error, epoch));
        void this.#refreshContext(epoch);
      }
    }
    this.#publish();
  }

  async #detach(): Promise<void> {
    this.#session.abort();
    const events = this.#events; this.#events = undefined;
    const watches = [...this.#documents, ...this.#questionWatches.values()];
    this.#documents = []; this.#questionWatches.clear(); this.#questionPending.clear(); this.#children.clear(); this.#questions.clear();
    await Promise.allSettled([...(events ? [events.stop()] : []), ...watches.map(watch => watch.stop())]);
  }

  async switchSession(id: string | number): Promise<void> {
    this.#assertOpen(); const request = ++this.#switchRequest;
    // Validate first: an invalid session selection must not strand the current
    // session without watches, especially while it is waiting for human input.
    let conversation: Conversation;
    try { conversation = await this.runtime.conversation(id, withAbortSignal(this.#lifetime.signal, BACKGROUND_CONTEXT)); }
    catch (error) { if (request === this.#switchRequest) this.#fail(error); throw error; }
    if (this.#closed || request !== this.#switchRequest) return;
    const epoch = ++this.#epoch;
    await this.#detach();
    if (!this.#valid(epoch)) return;
    this.#session = new AbortController();
    this.#conversation = conversation; this.#projection = new TuiProjection();
    this.#snapshot = { ...this.#snapshot, sessionId: conversation.id, entries: [], questions: [], plan: [], context: undefined, mode: 'build', error: undefined };
    await conversation.commit(async tx => { await tx.doc(ConversationModeDoc, conversation.id); await tx.doc(WorkDoc, conversation.id); }, this.#context());
    const events = await watchEvents(this.runtime.harness, conversation.id, this.#context());
    if (!this.#valid(epoch)) { await events.stop(); return; }
    this.#events = events;
    this.#observe([events.snapshot], epoch);
    events.start(async batch => { this.#observe(batch, epoch); });
    const work = await this.runtime.harness.watchDoc(WorkDoc, conversation.id, this.#context());
    if (work) {
      if (!this.#valid(epoch)) { await work.stop(); return; }
      const apply = (value: typeof work.value) => { if (this.#valid(epoch)) { this.#snapshot = { ...this.#snapshot, plan: (value?.plan ?? []).slice(0, 30).map(step => ({ step: sanitizeText(step.step, 500), status: sanitizeText(step.status, 30) })) }; this.#publish(); } };
      this.#documents.push(work); work.start(async value => { apply(value); }); apply(work.value);
    }
    const mode = await this.runtime.harness.watchDoc(ConversationModeDoc, conversation.id, this.#context());
    if (mode) {
      if (!this.#valid(epoch)) { await mode.stop(); return; }
      const apply = (value: typeof mode.value) => { if (this.#valid(epoch)) { this.#snapshot = { ...this.#snapshot, mode: value?.mode ?? 'build' }; this.#publish(); } };
      this.#documents.push(mode); mode.start(async value => { apply(value); }); apply(mode.value);
    }
    await this.#attachQuestions(conversation.id, epoch);
    if (!this.#valid(epoch)) return;
    this.#flush(); void this.#refreshContext(epoch);
  }

  async send(text: string, images: string[] = []): Promise<number> {
    this.#assertOpen(); const epoch = this.#epoch; const conversation = this.#conversation;
    try {
      if (!text.trim() && !images.length) throw new Error('Enter a message or attach an image');
      const content = await withImages(text, images.map(path => resolve(this.runtime.config.workspace, path)), {
        stateDir: this.runtime.config.stateDir, supportsImages: this.runtime.config.model.input.includes('image'),
      });
      if (!this.#valid(epoch)) throw new Error('Session changed before message admission');
      const waiting = this.#context();
      const submission = await conversation.submit({ type: 'input', content, whenBusy: 'followUp' }, waiting);
      if (this.#valid(epoch)) { this.#projection.status = 'Running'; this.#projection.error = undefined; this.#publish(); }
      void submission.wait(waiting).then(settled => {
        if (!this.#valid(epoch)) return;
        if (settled.status !== 'done') this.#projection.status = `Input ${settled.status}`;
        this.#publish(); void this.#refreshContext(epoch);
      }).catch(error => { if (!this.#closed) this.#fail(error, epoch); });
      return submission.id;
    } catch (error) { this.#fail(error, epoch); throw error; }
  }

  async abort(): Promise<void> {
    this.#assertOpen(); const epoch = this.#epoch;
    try { await this.#conversation.abort(this.#context(), { background: true });
      if (this.#valid(epoch)) { this.#projection.status = 'Stopped'; await this.#refreshQuestions(this.#conversation.id, epoch); this.#publish(); }
    } catch (error) { this.#fail(error, epoch); throw error; }
  }

  async newSession(): Promise<void> {
    this.#assertOpen(); const request = this.#switchRequest;
    const conversation = await this.runtime.createConversation();
    if (!this.#closed && request === this.#switchRequest) await this.switchSession(conversation.id);
  }

  async sessions(): Promise<Array<{ id: number; label: string }>> {
    this.#assertOpen();
    return this.runtime.harness.commit(async tx => {
      const result: Array<{ id: number; label: string }> = []; let cursor: Cursor | undefined;
      for (let pageIndex = 0; pageIndex < 8 && result.length < 100; pageIndex++) {
        const page = await tx.scanConversations({ order: 'descending' }, 128, cursor);
        for (const record of page.items) {
          if (record.owner || result.length >= 100) continue;
          const first = (await tx.scanEntries({ conversationId: record.id, order: 'ascending' }, 16)).items;
          const message = first.flatMap(entry => entry.model ?? []).find(item => item.role === 'user');
          const text = !message ? '' : typeof message.content === 'string' ? message.content.slice(0, 80)
            : message.content.find(part => part.type === 'text')?.text.slice(0, 80) ?? '';
          result.push({ id: record.id, label: sanitizeText(text, 80).replace(/\s+/g, ' ').trim() || `Session ${record.id}` });
        }
        cursor = page.next; if (!cursor) break;
      }
      return result;
    }, this.#context());
  }

  async fork(at?: number): Promise<void> {
    this.#assertOpen(); let entry = at; const epoch = this.#epoch; const conversation = this.#conversation;
    if (entry === undefined) {
      let cursor: Cursor | undefined;
      for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
        const page = await conversation.entries({}, 64, cursor, this.#context());
        entry = page.items.find(item => AssistantEntry.is(item))?.id;
        if (entry !== undefined || !page.next) break; cursor = page.next;
      }
    }
    if (entry === undefined) throw new Error('No assistant entry is available to fork');
    if (!this.#valid(epoch)) return;
    const fork = await this.runtime.fork(conversation.id, entry);
    if (this.#valid(epoch)) await this.switchSession(fork.id);
  }

  async compact(): Promise<void> {
    this.#assertOpen(); const epoch = this.#epoch;
    try {
      const waiting = this.#context();
      const task = await this.#conversation.compact(undefined, waiting);
      if (this.#valid(epoch)) { this.#projection.status = 'Compacting'; this.#publish(); }
      void this.runtime.harness.waitForTask(task, waiting).then(() => this.#refreshContext(epoch)).catch(error => this.#fail(error, epoch));
    } catch (error) { this.#fail(error, epoch); throw error; }
  }

  async setMode(mode: 'build' | 'plan'): Promise<void> {
    this.#assertOpen(); if (!['build', 'plan'].includes(mode)) throw new Error('Invalid mode');
    const epoch = this.#epoch; const conversation = this.#conversation;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.runtime.harness.snapshot(AgentDoc, conversation.id, this.#context());
      const agent = await conversation.agent(this.#context());
      const selected = new Map<string, ToolRegistration>();
      for (const extension of agent.extensions) for (const tool of extension.tools ?? []) selected.set(tool.name, tool);
      // Agent.tools is model-facing, while Agent.callable omits model-only tools.
      // Derive the enabled set before modelTools filtering so hidden model-only
      // tools survive a plan/build round trip without broadening availability.
      const filter = before?.tools;
      const enabled = [...selected.values()].filter(tool => !filter ||
        (Array.isArray(filter) ? filter.includes(tool.name) : !filter.remove.includes(tool.name)));
      const changed = await conversation.commit(async tx => {
        const current = await tx.doc(AgentDoc, conversation.id);
        if (JSON.stringify(copyJson(current)) !== JSON.stringify(before ?? {})) return false;
        const state = await tx.doc(ConversationModeDoc, conversation.id);
        if (state.mode === mode) return true;
        if (mode === 'plan' && (await tx.doc(LiveDoc, conversation.id)).run)
          throw new Error('Stop active work before entering plan mode; running children retain their existing tools');
        const tools = mode === 'plan' ? enabled.filter(tool => PLAN_TOOLS.has(tool.name))
          : state.restore.flatMap(name => { const tool = selected.get(name); return tool ? [tool] : []; });
        if (mode === 'plan') state.restore = enabled.map(tool => tool.name);
        state.mode = mode;
        await configure(tx, conversation.id, { tools });
        return true;
      }, this.#context());
      if (changed) { if (this.#valid(epoch)) { this.#snapshot = { ...this.#snapshot, mode }; this.#publish(); } return; }
    }
    throw new Error('Agent settings changed while switching mode; retry');
  }

  async answer(questionId: number, text: string): Promise<void> {
    this.#assertOpen(); const epoch = this.#epoch;
    const question = [...this.#questions.values()].flat().find(item => item.id === questionId);
    if (!question) throw new Error('Question is no longer pending');
    try { await answerQuestion(this.runtime.harness, question.conversationId, questionId, text, this.#context());
      await this.#refreshQuestions(question.conversationId, epoch);
    } catch (error) { this.#fail(error, epoch); throw error; }
  }

  async diff(): Promise<string> {
    this.#assertOpen(); let output = '';
    const result = await this.#env.readOnlyCommand({ kind: 'git-diff' }, { timeout: 10,
      onOutput: chunk => { output += chunk.slice(0, 64_000 - output.length); } }, this.#context());
    getOrThrow(result); return sanitizeText(output, 64_000);
  }

  async files(query: string): Promise<string[]> {
    this.#assertOpen(); const listing = await listWorkspaceFiles(this.#env, '.', this.#context(), 512_000);
    const needle = query.toLocaleLowerCase('en-US');
    // Do not insert a sanitized alias that could refer to a different file.
    return listing.paths.filter(path => path.length <= 4_096 && sanitizeText(path, 4_096) === path && path.toLocaleLowerCase('en-US').includes(needle)).slice(0, 100);
  }

  async tools(name?: string) {
    this.#assertOpen();
    return this.runtime.toolCatalog({ sessionId: this.#conversation.id, all: true, name }, this.#context());
  }

  async provider() {
    this.#assertOpen();
    const { baseUrl, id, api, apiKeyEnv } = this.runtime.config.model;
    return { baseUrl, model: id, api, apiKeyEnv, ...await getProviderCredentialStatus(this.runtime.config.model) };
  }

  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.#epoch++; this.#switchRequest++; this.#lifetime.abort();
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    await this.#detach(); this.#listeners.clear();
    await this.#env.cleanup(BACKGROUND_CONTEXT);
  }
}
