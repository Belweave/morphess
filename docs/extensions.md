# Plugins, code mode, and delegation

Morphess registers capabilities in Pi Durable. Tools use native schema validation, task ownership, execution intents, and recovery.

## Trusted ESM plugins

Configure explicit module imports in `morphess.json`:

```json
{ "plugins": ["./plugins/digest.mjs"] }
```

Relative paths resolve from the workspace. Absolute paths are accepted. Bare specifiers use Node resolution from the Morphess loader module; install packages where that resolution can find them. HTTP and data URL imports are rejected. There is no automatic workspace plugin discovery.

A module must export a named `createExtension({ workspace })` factory. It may synchronously or asynchronously return either a native `Extension` or a bundle:

```ts
import type { Extension } from '@earendil-works/pi-durable';

type PluginResult = Extension | {
  extensions: Extension[];
  close?(): Promise<void> | void;
};
```

The factory receives a resolved workspace path. Bundle cleanup hooks run in reverse order on close or a later load failure. If acquisition fails before the factory returns a cleanup handle, the factory must release its own partial resources. Factories run on each runtime open; imports follow normal ESM caching. Changes require reopening the host.

Extension names must be nonempty and unique across configured plugins. Each tool must declare `replay: 'safe'` or `replay: 'unsafe'`; omission fails loading. Pi validates duplicate tools, prompt sections, and task definitions. Reserve existing application/tool names for their owners.

This local ESM plugin implements a pure tool with TypeBox input and structured output:

```js
import { createHash } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export function createExtension({ workspace }) {
  return defineExtension({
    name: 'digest-plugin',
    tools: [defineTool({
      name: 'digest_text',
      description: 'Return the SHA-256 digest of UTF-8 text.',
      parameters: Type.Object({
        text: Type.String({ maxLength: 100_000 }),
      }, { additionalProperties: false }),
      structuredOutputSchema: Type.Object({ sha256: Type.String() }),
      replay: 'safe',
      async execute({ text }, api, context) {
        context.abortSignal?.throwIfAborted();
        const value = {
          sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        };
        return {
          output: [{ type: 'text', text: JSON.stringify(value) }],
          structuredOutput: value,
        };
      },
    })],
  });
}
```

The plugin must resolve its own imports: declare dependencies in its package or install them alongside a local plugin. The host's global CLI installation does not make its dependencies globally importable from arbitrary workspace modules.

Trusted imports execute with the Node process's host authority, including files, processes, environment, and network. Prefer `api.env` for workspace operations and propagate `context` to cancellable calls. Workspace policy does not sandbox direct Node imports.

## Replay and lifecycle

A `safe` declaration allows an interrupted invocation to rerun. Use it for pure computation, side-effect-free reads, or native durable construction with justified deduplication. Non-idempotent external effects must use `unsafe`. Pi reuses completed tasks; an interrupted unsafe effect becomes an interrupted result instead of being automatically reissued.

Use native task ownership, `api.commit`, memos, and keyed `api.executeTool` for composition. Every nested call retains its own replay policy. A process can fail after a remote effect succeeds but before the result commits; local checkpoints alone cannot guarantee exactly-once remote execution.

`loadExtensions(specifiers, { workspace })` returns `{ extensions, close }`. `MorphessRuntime` installs those extensions and owns cleanup. Plugin configuration, tool arguments/results, and session state must not contain credentials that belong in the host environment.

## MCP

Configured MCP capabilities enter the same registry and are available to native tool execution and code mode, subject to enabled-tool selection and host policy. Use `morphess tools --all --json` to inspect installed names and `morphess tools <name> --session <id>` for schemas and availability.

See [MCP configuration and protocol capabilities](mcp.md) for transports, authentication references, discovery, resources, prompts, and task operations. The MCP reference is the source of truth for supported protocol features and their limits.

## Code mode

Code mode is enabled by default. Set `"codemode": false` to disable it. Its `code` argument runs JavaScript in a 128 MiB QuickJS VM. Scripts call enabled native, plugin, and MCP capabilities through `tools`; they have no direct Node, filesystem, network, or timer access.

After loading the digest plugin, a code-mode body can call:

```js
const result = await tools.digest_text({ text: 'hello' });
text(result.sha256);
```

Use `ALL_TOOLS`, `searchTools`, `describeTool`, and `describeNamespace` to discover script-visible names and argument contracts. Enabled deferred tools can be called from scripts without first loading model-facing declarations. `tool_search` loads matching deferred declarations for direct calls on subsequent model requests.

Native nested calls validate arguments, retain ownership, obey tool policy, and report failures. Pi journals deterministic script execution and reattaches keyed calls during recovery. Script replay does not authorize replay of an unsafe nested effect. Code mode is model-callable only and cannot recursively invoke itself. Direct `models.*` APIs remain disabled so model requests retain durable admission and budget controls.

Bound parallel calls even when using `Promise.all`; the host's execution wrapper caps active work. VM limits apply to the script and do not isolate trusted plugins, MCP processes, or explicitly trusted host shell commands. Plan mode excludes code mode and deferred loading.

## Delegation

`delegate` starts a task-owned child conversation and waits for its textual answer:

```json
{
  "task": "Inspect the parser and report edge cases with file references.",
  "role": "reviewer",
  "timeoutMs": 600000
}
```

| Argument | Contract |
| --- | --- |
| `task` | 1–200,000 characters |
| `role` | `researcher` by default; `researcher`, `reviewer`, or `coder` |
| `timeoutMs` | 600,000 by default; integer from 100 to 3,600,000 |

Output is JSON text with numeric `conversationId`, `role`, and textual `answer`. Running details expose the child ID and role.

Researcher/reviewer roles receive only enabled parent tools on the positive read allowlist: `read`, `read_bytes`, `ls`, `find`, `grep`, `glob`, `search`, `list_files`, `read_instructions`, `load_skill`, `git_status`, and `git_diff`. Unknown tools are not treated as read-only. Coder children receive the parent's currently exposed/callable/deferred tools with delegation removed. Neither role can enable an unavailable tool. Children preserve the parent's selected extensions and host policy.

Children share the workspace and environment; delegation does not create an isolated filesystem or worktree. Assign file ownership when coders work concurrently. Roles constrain model tool access rather than trusted plugin code.

`limits.maxConcurrentAgents` accepts 1–16 and bounds active delegated calls across the session. Admission is transactional; a full cap rejects rather than queues a call. `maxAgentDepth: 0` disables delegation. Positive values currently allow one child level; children cannot delegate further.

Task ownership propagates explicit abort to the child. Timeout aborts remaining child work but cannot undo completed effects. Host close preserves unfinished work. Recovery locates the existing owned child and uses a stable submission request ID, avoiding duplicate creation/input. The saved deadline includes downtime. Child tools keep their individual replay policies.
