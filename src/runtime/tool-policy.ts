import { defineExtension, wrapTool } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { WorkspaceMode } from '../policy/workspace.js';

/** Pure native resolution filter. ExecutionEnv remains the enforcement boundary. */
export function createHostToolPolicy(mode: WorkspaceMode) {
  return defineExtension({
    name: 'morphess.host-tool-policy',
    wraps: (CodingTools.tools ?? []).filter(tool => tool.name === 'bash' && mode !== 'trusted'
      || (tool.name === 'write' || tool.name === 'edit') && mode === 'read-only')
      .map(tool => wrapTool(tool, resolved => ({ ...resolved, callers: [] }))),
  });
}
