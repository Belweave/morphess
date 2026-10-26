import { defineDoc } from '@earendil-works/pi-durable';
import type { MorphessConfig } from '../config.js';

/** Selected profiles only, without credentials; restored before Pi resumes work. */
export const ModelProfilesDoc = defineDoc<{ endpoint: string; api: string; defaultId: string; profiles: MorphessConfig['model'][] }>({
  kind: 'morphess.model-profiles', version: 1, scope: 'session',
  initial: () => ({ endpoint: '', api: '', defaultId: '', profiles: [] }), checkpointWhen: () => false,
});

export const WorkspaceDoc = defineDoc<{ workspace: string; schema: number }>({
  kind: 'morphess.workspace', version: 1, scope: 'session',
  initial: () => ({ workspace: '', schema: 1 }), checkpointWhen: () => false,
});
