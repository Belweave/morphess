import type { Agent, AgentState, RegistrySnapshot, ToolRegistration } from '@earendil-works/pi-durable';
import type { WorkspaceMode } from '../policy/workspace.js';

export type ToolOrigin = 'builtin' | 'plugin' | 'mcp' | 'host';
export type ToolCatalogStatus = 'available' | 'policy-blocked' | 'deferred' | 'disabled' | 'not-selected' | 'nested-only' | 'not-offered';
export interface ToolCatalogOptions {
  sessionId?: string | number;
  name?: string;
  all?: boolean;
  includeParameters?: boolean;
}
export interface ToolCatalogEntry {
  name: string;
  /** Extension providing the active definition, independently of wrappers. */
  source: string;
  origin: ToolOrigin;
  description: string;
  replay: 'safe' | 'unsafe';
  selected: boolean;
  /** Enabled by stored extension/tool selection; native exposure is reported separately. */
  enabled: boolean;
  offeredToModel: boolean;
  callableByTools: boolean;
  deferred: boolean;
  /** True when Pi currently keeps this tool in its deferred discovery set. */
  deferredPending: boolean;
  status: ToolCatalogStatus;
  reason?: string;
  /** Selected wrapping extensions, in native resolution order. */
  wrappers: string[];
  /** True when metadata came from the native resolved tool rather than the registered definition. */
  resolved: boolean;
  parameters?: Record<string, unknown>;
}
export interface ToolCatalog {
  sessionId: number;
  policy: WorkspaceMode;
  scheduling: 'paused' | 'running' | 'closing';
  /** Snapshot only: argument validation and arbitrary extension guards are not executed. */
  availabilityBasis: 'native-selection-and-known-host-policy';
  tools: ToolCatalogEntry[];
  extensions: Array<{ name: string; origin: ToolOrigin; selected: boolean; toolCount: number }>;
}
export interface ToolCatalogContext {
  sessionId: number;
  policy: WorkspaceMode;
  scheduling: ToolCatalog['scheduling'];
  origins?: ReadonlyMap<string, ToolOrigin>;
}

function enabledBySelection(name: string, state: AgentState): boolean {
  if (Array.isArray(state.tools)) return state.tools.includes(name);
  return !state.tools?.remove.includes(name);
}

/**
 * Describe Pi's native resolution without executing tools, rendering prompt sections,
 * invoking guards, or reimplementing agent resolution. One row per tool name: the
 * last selected provider wins, just as it does in Pi; unselected registrations are
 * included by --all only when no selected provider supplies that name.
 */
export function createToolCatalog(snapshot: RegistrySnapshot, agent: Agent, state: AgentState, context: ToolCatalogContext, options: ToolCatalogOptions = {}): ToolCatalog {
  const selected = new Set(agent.extensions.map(extension => extension.name));
  const providers = new Map<string, { source: string; tool: ToolRegistration }>();
  for (const { extension, tool } of snapshot.tools()) providers.set(tool.name, { source: extension.name, tool });
  for (const extension of agent.extensions) for (const tool of extension.tools ?? []) providers.set(tool.name, { source: extension.name, tool });
  const resolved = new Map([...agent.tools, ...agent.callable, ...agent.deferred].map(tool => [tool.name, tool]));
  const offered = new Set(agent.tools.map(tool => tool.name));
  const callable = new Set(agent.callable.map(tool => tool.name));
  const pending = new Set(agent.deferred.map(tool => tool.name));
  const origin = (name: string): ToolOrigin => context.origins?.get(name) ?? (name.startsWith('morphess-mcp-') ? 'mcp' : 'host');
  const rows: ToolCatalogEntry[] = [];
  for (const [name, provider] of providers) {
    const tool = resolved.get(name) ?? provider.tool;
    const isSelected = selected.has(provider.source);
    const enabled = isSelected && enabledBySelection(name, state);
    const offeredToModel = offered.has(name);
    const callableByTools = callable.has(name);
    const deferredPending = pending.has(name);
    let status: ToolCatalogStatus;
    let reason: string | undefined;
    if (!isSelected) { status = 'not-selected'; reason = 'Providing extension is not selected by this conversation.'; }
    else if (!enabled) { status = 'disabled'; reason = 'Disabled by this conversation\'s tool selection.'; }
    else if (deferredPending) { status = 'deferred'; reason = 'Not offered to the model yet; discover it with tool_search or code mode.'; }
    else if (offeredToModel) status = 'available';
    else if (callableByTools) { status = 'nested-only'; reason = 'Callable by other tools, but not currently offered to the model.'; }
    else { status = 'not-offered'; reason = 'Pi did not expose this tool to model or nested calls; model selection, callers, or a failed wrapper may exclude it.'; }
    if (enabled && provider.source === 'coding-tools' && origin(provider.source) === 'builtin') {
      if (name === 'bash' && context.policy !== 'trusted') {
        status = 'policy-blocked'; reason = 'Host shell execution requires explicit trusted mode or an isolated execution backend.';
      } else if ((name === 'write' || name === 'edit') && context.policy === 'read-only') {
        status = 'policy-blocked'; reason = 'Workspace file mutations are blocked by read-only policy.';
      }
    }
    if (enabled && name === 'ask_user' && agent.extensions.some(extension => extension.name === 'morphess-noninteractive-questions' && origin(extension.name) === 'builtin' && (extension.hooks?.length ?? 0) > 0)) {
      status = 'policy-blocked'; reason = 'This host has no interactive answer channel; return the question in final text.';
    }
    const row: ToolCatalogEntry = {
      name, source: provider.source, origin: origin(provider.source), description: tool.description,
      replay: tool.replay ?? 'unsafe', selected: isSelected, enabled, offeredToModel, callableByTools,
      deferred: tool.deferred === true, deferredPending, status, ...(reason ? { reason } : {}),
      wrappers: agent.extensions.filter(extension => extension.wraps?.some(wrap => 'tool' in wrap && wrap.tool === name)).map(extension => extension.name),
      resolved: resolved.has(name),
      ...(options.includeParameters || options.name ? { parameters: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown> } : {}),
    };
    if (options.name ? name === options.name : options.all || offeredToModel) rows.push(row);
  }
  if (options.name && rows.length === 0) throw new Error(`Tool not found: ${options.name}`);
  return {
    sessionId: context.sessionId, policy: context.policy, scheduling: context.scheduling,
    availabilityBasis: 'native-selection-and-known-host-policy', tools: rows,
    extensions: snapshot.installed().map(extension => ({ name: extension.name, origin: origin(extension.name), selected: selected.has(extension.name), toolCount: extension.tools?.length ?? 0 })),
  };
}
