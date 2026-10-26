import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, defineTool, section } from '@earendil-works/pi-durable';

type WorkState = { plan: Array<{ step: string; status: string }>; notes: Record<string, string> };
export const WorkDoc = defineDoc<WorkState>({
  kind: 'morphess.work', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf',
  initial: () => ({ plan: [], notes: {} }), checkpointWhen: () => false,
});

export function createWorkExtension() {
  return defineExtension({
    name: 'morphess.work',
    tools: [
      defineTool({
        name: 'update_plan', replay: 'safe',
        description: 'Replace the durable task plan. Keep at most one step in progress. Survives restarts and forks.',
        parameters: Type.Object({ steps: Type.Array(Type.Object({ step: Type.String({ minLength: 1, maxLength: 500 }), status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]) }), { maxItems: 30 }) }),
        execute: async ({ steps }, api, context) => {
          if (steps.filter((step) => step.status === 'in_progress').length > 1) throw new Error('Only one step may be in progress');
          await api.commit(async (tx) => { (await tx.doc(WorkDoc, api.conversationId)).plan = steps; }, context);
          return { output: [{ type: 'text', text: JSON.stringify(steps) }] };
        },
      }),
      defineTool({
        name: 'remember', replay: 'safe',
        description: 'Save or replace a concise durable note by key. Preserve decisions, evidence, and unfinished work across compaction.',
        parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 100 }), note: Type.String({ maxLength: 4_000 }) }),
        execute: async ({ key, note }, api, context) => {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Reserved note key');
          await api.commit(async (tx) => {
            const state = await tx.doc(WorkDoc, api.conversationId);
            if (!(key in state.notes) && Object.keys(state.notes).length >= 50) throw new Error('Note limit reached; replace an existing key');
            state.notes[key] = note;
          }, context);
          return { output: [{ type: 'text', text: `Saved ${key}` }] };
        },
      }),
    ],
    sections: [section('work_state', async (input, context) => {
      const state = await input.read.snapshot(WorkDoc, input.conversationId, context);
      if (!state || (!state.plan.length && !Object.keys(state.notes).length)) return undefined;
      return JSON.stringify(state);
    })],
  });
}
