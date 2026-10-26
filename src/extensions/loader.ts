import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRegistry, type Extension } from '@earendil-works/pi-durable';

export interface ExtensionPlugin {
  extensions: Extension[];
  close?(): Promise<void> | void;
}

/**
 * Explicit trusted imports only; plugins execute with the full authority of this Node process.
 * Export `createExtension({ workspace }) => Extension | { extensions, close? }` from an ESM
 * module. Relative/absolute paths resolve from workspace; bare specifiers use Node package resolution.
 * Imports have normal ESM module caching; factories run once per loadExtensions invocation.
 * Each tool must declare replay: 'safe' or 'unsafe'; external effects must use 'unsafe'.
 */
export async function loadExtensions(specifiers: string[], options: { workspace: string }): Promise<{
  extensions: Extension[];
  close(): Promise<void>;
}> {
  const extensions: Extension[] = [];
  const cleanups: Array<() => Promise<void> | void> = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Extension cleanup failed');
  };
  const registry = createRegistry();
  try {
    for (const specifier of specifiers) {
      if (!specifier || /^(?:https?|data):/i.test(specifier)) throw new Error('Plugins require a local ESM file or installed package');
      const url = isAbsolute(specifier) || specifier.startsWith('.')
        ? pathToFileURL(resolve(options.workspace, specifier)).href : specifier;
      const module: unknown = await import(url);
      if (typeof module !== 'object' || module === null || !('createExtension' in module) || typeof module.createExtension !== 'function')
        throw new Error(`Plugin ${specifier} must export createExtension({ workspace })`);
      const loaded: Extension | ExtensionPlugin = await module.createExtension({ workspace: resolve(options.workspace) });
      if (typeof loaded !== 'object' || loaded === null) throw new Error(`Plugin ${specifier} returned no extension`);
      const plugin = 'extensions' in loaded ? loaded : { extensions: [loaded] };
      if (plugin.close) cleanups.push(() => plugin.close!());
      for (const extension of plugin.extensions) {
        if (!extension.name || registry.snapshot().extension(extension.name))
          throw new Error(`Plugin extension name is missing or duplicated: ${extension.name}`);
        for (const tool of extension.tools ?? []) {
          if (tool.replay !== 'safe' && tool.replay !== 'unsafe') throw new Error(`Plugin tool ${tool.name} must declare replay safety`);
        }
        // Delegate duplicate tools, sections and task validation to Pi's registry.
        registry.install(extension);
        extensions.push(extension);
      }
    }
    return { extensions, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Plugin load and rollback failed'); }
    throw error;
  }
}
