import { defineDoc } from '@earendil-works/pi-durable';

export const WorkspaceDoc = defineDoc<{ workspace: string; schema: number }>({
  kind: 'morphess.workspace', version: 1, scope: 'session',
  initial: () => ({ workspace: '', schema: 1 }), checkpointWhen: () => false,
});
