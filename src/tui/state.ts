import type { AgentEvent, EntryRecord, SnapshotEvent, UsageState } from '@earendil-works/pi-durable';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { ContextBudget } from '../context/budget.js';
import type { UserQuestion } from '../interaction/index.js';

export interface TuiEntry {
  id: string;
  entryId?: number;
  role: 'user' | 'assistant' | 'tool' | 'notice';
  text: string;
  thinking?: string;
  toolName?: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  revision: number;
}

export interface TuiSnapshot {
  sessionId: number;
  workspace: string;
  model: string;
  policy: string;
  mode: 'build' | 'plan';
  busy: boolean;
  entries: TuiEntry[];
  questions: UserQuestion[];
  plan: Array<{ step: string; status: string }>;
  usage: { input: number; output: number; cacheRead: number; cost: number };
  context?: ContextBudget;
  status: string;
  error?: string;
  version: number;
}

export const PREVIEW_LIMITS = Object.freeze({ entries: 80, text: 24_000, detail: 64_000 });

/** Strip terminal escape/control sequences and bound display data independently of durable history. */
export function sanitizeText(value: string, limit: number = PREVIEW_LIMITS.text): string {
  const bounded = value.slice(0, Math.max(0, limit));
  return bounded
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

/** Bounded traversal: argument previews never stringify an entire multimodal payload. */
export function previewDetail(value: unknown, limit: number = PREVIEW_LIMITS.detail): string {
  let result = '';
  let nodes = 0;
  const append = (part: string) => { if (result.length < limit) result += part.slice(0, limit - result.length); };
  const walk = (item: unknown, depth: number): void => {
    if (result.length >= limit) return;
    if (++nodes > 2_000 || depth > 12) { append('"…"'); return; }
    if (typeof item === 'string') { append(JSON.stringify(item.slice(0, limit - result.length))); return; }
    if (item === null || typeof item !== 'object') { append(JSON.stringify(item) ?? 'null'); return; }
    if (Array.isArray(item)) {
      append('[');
      for (let index = 0; index < item.length && nodes <= 2_000 && result.length < limit; index++) {
        if (index) append(','); walk(item[index], depth + 1);
      }
      append(']');
    } else {
      append('{'); let index = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (nodes > 2_000 || result.length >= limit) break;
        if (index++) append(','); append(JSON.stringify(key.slice(0, 256))); append(':');
        walk((item as Record<string, unknown>)[key], depth + 1);
      }
      append('}');
    }
  };
  walk(value, 0);
  return sanitizeText(result, limit);
}

function contentText(message: Message, limit: number = PREVIEW_LIMITS.text): string {
  if (typeof message.content === 'string') return sanitizeText(message.content, limit);
  let text = '';
  for (const part of message.content) {
    if (text.length >= limit) break;
    if (part.type === 'text') text += part.text.slice(0, limit - text.length);
    else if (part.type === 'image') text += '\n[Image attachment]\n';
  }
  return sanitizeText(text, limit);
}

function thinkingText(message: AssistantMessage): string {
  let text = '';
  for (const part of message.content) {
    if (text.length >= PREVIEW_LIMITS.text) break;
    if (part.type === 'thinking') text += part.thinking.slice(0, PREVIEW_LIMITS.text - text.length);
  }
  return sanitizeText(text);
}

function usageSummary(usage: UsageState): TuiSnapshot['usage'] {
  const sum = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  for (const bucket of [usage.models, usage.tools]) for (const value of Object.values(bucket)) {
    sum.input += value.input; sum.output += value.output; sum.cacheRead += value.cacheRead; sum.cost += value.cost.total;
  }
  return sum;
}

/** A bounded display projection; never retains transcript entries or model payloads. */
export class TuiProjection {
  entries: TuiEntry[] = [];
  busy = false;
  status = 'Ready';
  error: string | undefined;
  usage: TuiSnapshot['usage'] = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  #streamId: string | undefined;
  #sequence = 0;
  #blocks = new Map<number, { kind: 'text' | 'thinking'; text: string }>();
  #baseline: Map<string, TuiEntry> | undefined;
  #toolOutput = new Map<string, string>();
  #runActive = false;
  #compactions = new Set<number>();

  #row(id: string, patch: Omit<TuiEntry, 'id' | 'revision'>): void {
    const current = this.entries.find(row => row.id === id);
    const previous = current ?? this.#baseline?.get(id);
    const equal = previous && Object.keys(patch).every(key => previous[key as keyof TuiEntry] === patch[key as keyof typeof patch])
      && ['entryId', 'thinking', 'toolName', 'detail'].every(key => patch[key as keyof typeof patch] === previous[key as keyof TuiEntry]);
    if (current && equal) return;
    const row = equal ? previous : { id, ...patch, revision: (previous?.revision ?? 0) + 1 };
    this.entries = current ? this.entries.map(item => item.id === id ? row : item) : [...this.entries, row].slice(-PREVIEW_LIMITS.entries);
    if (this.#toolOutput.size > PREVIEW_LIMITS.entries) {
      const retained = new Set(this.entries.map(entry => entry.id));
      for (const key of this.#toolOutput.keys()) if (!retained.has(key)) this.#toolOutput.delete(key);
    }
  }

  #entry(entry: EntryRecord): void {
    for (const message of entry.model ?? []) {
      if (message.role === 'system') continue;
      if (message.role === 'toolResult') {
        const output = contentText(message, PREVIEW_LIMITS.detail);
        this.#row(`tool:${message.toolCallId}`, {
          entryId: entry.id, role: 'tool', toolName: sanitizeText(message.toolName, 200),
          text: sanitizeText(output), detail: output, status: message.isError ? 'error' : 'done',
        });
        this.#toolOutput.delete(`tool:${message.toolCallId}`);
      } else if (message.role === 'assistant') {
        const known = this.entries.find(row => row.entryId === entry.id && row.role === 'assistant')
          ?? [...this.#baseline?.values() ?? []].find(row => row.entryId === entry.id && row.role === 'assistant');
        const id = known?.id ?? this.#streamId ?? `entry:${entry.id}`;
        const text = contentText(message) || sanitizeText(message.errorMessage ?? '');
        const thinking = thinkingText(message);
        if (!text && !thinking && !message.errorMessage) {
          this.entries = this.entries.filter(row => row.id !== id);
          this.#streamId = undefined; this.#blocks.clear();
          continue;
        }
        this.#row(id, { entryId: entry.id, role: 'assistant', text, thinking,
          status: ['error', 'aborted'].includes(message.stopReason) ? 'error' : 'done',
          ...(message.errorMessage ? { detail: sanitizeText(message.errorMessage, PREVIEW_LIMITS.detail) } : {}),
        });
        this.#streamId = undefined; this.#blocks.clear();
      } else if (message.role === 'user') {
        this.#row(`entry:${entry.id}`, { entryId: entry.id, role: 'user', text: contentText(message), status: 'done' });
      }
    }
  }

  #start(message: AssistantMessage): void {
    this.#streamId ??= `stream:${++this.#sequence}`;
    this.#blocks.clear();
    for (let index = 0; index < message.content.length && this.#blocks.size < 128; index++) {
      const block = message.content[index]!;
      if (block.type === 'text') this.#blocks.set(index, { kind: 'text', text: block.text.slice(0, PREVIEW_LIMITS.text) });
      if (block.type === 'thinking') this.#blocks.set(index, { kind: 'thinking', text: block.thinking.slice(0, PREVIEW_LIMITS.text) });
    }
    this.#renderStream();
  }

  #renderStream(): void {
    this.#streamId ??= `stream:${++this.#sequence}`;
    let text = ''; let thinking = '';
    for (const [, block] of [...this.#blocks].sort(([a], [b]) => a - b)) {
      if (block.kind === 'text') text += block.text.slice(0, PREVIEW_LIMITS.text - text.length);
      else thinking += block.text.slice(0, PREVIEW_LIMITS.text - thinking.length);
    }
    if (!text && !thinking && !this.entries.some(row => row.id === this.#streamId)) return;
    this.#row(this.#streamId, { role: 'assistant', text: sanitizeText(text), thinking: sanitizeText(thinking), status: 'running' });
  }

  snapshot(event: SnapshotEvent): void {
    const streamId = this.#streamId;
    this.#baseline = new Map(this.entries.map(entry => [entry.id, entry]));
    this.entries = []; this.#streamId = undefined; this.#blocks.clear();
    this.#toolOutput.clear();
    for (const entry of event.entries.slice(-PREVIEW_LIMITS.entries)) this.#entry(entry);
    this.#runActive = event.run !== undefined;
    this.#compactions = new Set(event.compactions.map(compaction => compaction.taskId));
    this.busy = this.#runActive || this.#compactions.size > 0;
    this.status = event.generation?.retry ? 'Retrying model' : this.busy ? 'Running' : 'Ready';
    this.error = event.compactionFailure ? sanitizeText(event.compactionFailure.error) : undefined;
    this.usage = usageSummary(event.usage);
    if (event.generation?.message) { this.#streamId = streamId; this.#start(event.generation.message); }
    for (const slot of [...event.tools.slice(-PREVIEW_LIMITS.entries), ...event.nestedTools.slice(-PREVIEW_LIMITS.entries)].slice(-PREVIEW_LIMITS.entries)) {
      if (slot.status === 'done' && this.entries.some(row => row.id === `tool:${slot.callId}`)) continue;
      this.#toolOutput.set(`tool:${slot.callId}`, (slot.output ?? '').slice(0, PREVIEW_LIMITS.detail));
      this.#row(`tool:${slot.callId}`, { role: 'tool', toolName: sanitizeText(slot.name, 200), text: sanitizeText(slot.output ?? ''),
        detail: slot.details === undefined ? undefined : previewDetail(slot.details), status: slot.status !== 'done' ? 'running'
          : 'summary' in slot ? slot.summary?.isError ? 'error' : 'done' : 'entry' in slot && slot.entry !== undefined ? 'done' : 'error' });
    }
    this.#baseline = undefined;
  }

  apply(events: readonly AgentEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'snapshot': this.snapshot(event); break;
        case 'run_start': this.#runActive = true; this.busy = true; this.status = 'Running'; this.error = undefined; break;
        case 'run_end': this.#runActive = false; this.busy = this.#compactions.size > 0; this.status = this.busy ? 'Compacting' : 'Ready'; break;
        case 'message_start': if (event.message.role === 'assistant') this.#start(event.message); break;
        case 'message_update':
          for (const change of event.changes) {
            if (change.type === 'message') { this.#start(change.message); continue; }
            if (change.type === 'text_delta' || change.type === 'thinking_delta') {
              const kind = change.type === 'text_delta' ? 'text' : 'thinking';
              const old = this.#blocks.get(change.contentIndex);
              if (old || this.#blocks.size < 128) this.#blocks.set(change.contentIndex, { kind, text: ((old?.text ?? '') + change.delta.slice(0, PREVIEW_LIMITS.text)).slice(0, PREVIEW_LIMITS.text) });
            } else if ('block' in change && (this.#blocks.has(change.contentIndex) || this.#blocks.size < 128)) {
              const block = change.block;
              if (block.type === 'text') this.#blocks.set(change.contentIndex, { kind: 'text', text: block.text.slice(0, PREVIEW_LIMITS.text) });
              else if (block.type === 'thinking') this.#blocks.set(change.contentIndex, { kind: 'thinking', text: block.thinking.slice(0, PREVIEW_LIMITS.text) });
              else this.#blocks.delete(change.contentIndex);
            }
          }
          this.#renderStream(); break;
        case 'message_end': case 'entry_appended': this.#entry(event.entry); break;
        case 'tool_execution_start':
          this.#row(`tool:${event.toolCallId}`, { role: 'tool', toolName: sanitizeText(event.toolName, 200), text: '', detail: previewDetail(event.args), status: 'running' }); break;
        case 'tool_execution_update': {
          const id = `tool:${event.toolCallId}`;
          const previous = this.entries.find(row => row.id === id);
          let output = this.#toolOutput.get(id) ?? previous?.text ?? '';
          if (event.output) output = 'set' in event.output ? event.output.set.slice(0, PREVIEW_LIMITS.detail)
            : output.slice(event.output.trimStart ?? 0) + (event.output.append ?? '').slice(0, PREVIEW_LIMITS.detail);
          output = output.slice(0, PREVIEW_LIMITS.detail); this.#toolOutput.set(id, output);
          this.#row(id, { role: 'tool', toolName: sanitizeText(event.toolName, 200), text: sanitizeText(output), status: 'running',
            detail: event.details === undefined ? output || previous?.detail : previewDetail(event.details) }); break;
        }
        case 'tool_execution_end': {
          if (event.entry) { this.#entry(event.entry); break; }
          const id = `tool:${event.toolCallId}`; const previous = this.entries.find(row => row.id === id);
          this.#row(id, { role: 'tool', toolName: sanitizeText(event.toolName, 200), text: previous?.text ?? '', detail: previous?.detail,
            status: event.result?.isError || !event.result ? 'error' : 'done' }); break;
        }
        case 'usage_changed': this.usage = usageSummary(event.usage); break;
        case 'task_failed': this.error = sanitizeText(event.message); this.status = 'Error'; break;
        case 'auto_retry_start': this.status = 'Retrying model'; this.error = sanitizeText(event.errorMessage); break;
        case 'auto_retry_end': this.status = 'Running'; break;
        case 'compaction_start': this.#compactions.add(event.taskId); this.busy = true; this.status = 'Compacting'; break;
        case 'compaction_end': this.#compactions.delete(event.taskId); this.busy = this.#runActive || this.#compactions.size > 0;
          this.status = this.#compactions.size ? 'Compacting' : this.#runActive ? 'Running' : 'Ready';
          if (event.error) this.error = sanitizeText(event.error); break;
      }
    }
  }
}
