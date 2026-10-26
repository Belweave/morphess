# Extensions, MCP, and delegation

Morphess installs extensions into Pi Durable's native registry. Pi owns tool validation, durable tasks, conversation state, and recovery. Extensions add tools, prompt sections, hooks, wrappers, or native task definitions; they do not need another agent loop.

## Trusted ESM plugins

List plugins explicitly in `morphess.json`:

```json
{
  "plugins": ["./plugins/digest.mjs"]
}
```

Relative plugin paths resolve from the configured workspace. Absolute paths are accepted. Bare package specifiers use Node's normal package resolution from the loader module; install the package where that resolution can find it. HTTP and data URL imports are rejected. Nothing scans the workspace for plugins automatically.

Each module must export a named `createExtension` factory. A default export alone is insufficient. The factory receives the resolved workspace and may return synchronously or asynchronously:

```ts
import type { Extension } from '@earendil-works/pi-durable';

export function createExtension(options: { workspace: string }):
  | Extension
  | { extensions: Extension[]; close?(): Promise<void> | void };
```

The same union may be wrapped in a `Promise`. Use the bundle form when a plugin needs several extensions or a cleanup hook. Extension names must be nonempty and unique across the configured plugins. Pi additionally checks duplicate tools within an extension, prompt section keys, and native task definitions.

This complete JavaScript plugin exposes a pure tool with validated input and structured output. Save it as `plugins/digest.mjs`:

```js
import { createHash } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export function createExtension({ workspace }) {
  const digest = defineTool({
    name: 'digest_text',
    description: 'Return the SHA-256 digest of supplied UTF-8 text.',
    parameters: Type.Object({
      text: Type.String({ maxLength: 100_000 }),
    }, { additionalProperties: false }),
    structuredOutputSchema: Type.Object({ sha256: Type.String() }),
    // Pure computation: a crash may safely repeat it with the same arguments.
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
  });

  return defineExtension({ name: 'example-digest', tools: [digest] });
}
```

The factory can use `workspace` to configure a tool, and `api` exposes invocation-scoped Pi operations. Prefer `api.env` for workspace access and propagate `context` to cancellable operations. The example imports Node directly to emphasize the plugin's actual authority: trusted plugin code runs in the Morphess Node process and can access host files, environment variables, processes, and the network. Workspace policy does not sandbox imports or prevent a plugin from bypassing `api.env`. Reserve application extension and built-in tool names for their existing owners; registry overrides are executable changes to runtime behavior.

Every plugin tool must explicitly declare `replay: 'safe'` or `replay: 'unsafe'`. The loader rejects tools that omit it. Use `unsafe` for non-idempotent effects, including remote mutations, messages, and process execution that can change external state. A `safe` declaration authorizes Pi to rerun an interrupted invocation; it is a contract the plugin author must justify. Pi does not rerun completed tool tasks. An interrupted unsafe call reports uncertainty rather than automatically repeating its effect.

For composed operations, use native task ownership, transactional `api.commit`, durable memos, and keyed `api.executeTool` calls where appropriate. Each nested tool retains its own replay policy. Returning success from an external operation and then crashing before its result commits remains an uncertain outcome; a local success flag cannot provide exactly-once execution at a remote service.

The factory runs for each runtime open, while module imports retain normal ESM caching. The loader does not hot reload modules. Bundle cleanup hooks run in reverse load order when the runtime closes or a later plugin fails to load; the loader attempts all registered cleanups and aggregates failures. Cleanup is idempotent at the loader level. If a factory fails before returning its bundle, that factory must release any resources it already acquired.

The programmatic entry point is:

```ts
loadExtensions(specifiers: string[], { workspace: string })
// Promise<{ extensions: Extension[]; close(): Promise<void> }>
```

The runtime installs the returned extensions and owns the returned cleanup handle.

## MCP servers

MCP configuration is a strict union selected by `transport`. Unknown fields are rejected. Server names must be nonempty and unique. These are the supported fields:

| Transport | Required fields | Optional fields and defaults |
| --- | --- | --- |
| `stdio` | `transport`, `name`, `command` | `args: []`, `env: {}`, `cwd`, `timeoutMs: 30000` |
| `http` | `transport`, `name`, `url` | `headers: {}`, `timeoutMs: 30000` |

`command`, `name`, and an optional `cwd` are nonempty strings. `args` is an array of strings. `timeoutMs` is a positive safe integer in milliseconds. HTTP URLs must use `http:` or `https:` without a username or password. `http` uses MCP Streamable HTTP, rather than the legacy SSE transport.

For both transports, environment references are names rather than secret values:

```json
{
  "mcp": [
    {
      "transport": "stdio",
      "name": "local-index",
      "command": "node",
      "args": ["./integrations/local-mcp-server.mjs"],
      "cwd": ".",
      "env": { "INDEX_TOKEN": "MORPHESS_INDEX_TOKEN" },
      "timeoutMs": 30000
    },
    {
      "transport": "http",
      "name": "issue-tracker",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "MORPHESS_ISSUES_AUTHORIZATION" },
      "timeoutMs": 30000
    }
  ]
}
```

Set the referenced variables in the environment launching Morphess. `INDEX_TOKEN` receives the value of `MORPHESS_INDEX_TOKEN`. The HTTP `Authorization` header receives the complete value of `MORPHESS_ISSUES_AUTHORIZATION`, including any required `Bearer ` prefix. Values are not interpolated: `${VARIABLE}` and literal credentials are not valid reference names. Reference names must match `[A-Za-z_][A-Za-z0-9_]*`; a missing referenced variable fails startup.

`loadConfig` resolves a supplied stdio `cwd` relative to the configuration file, independently of workspace-relative plugin paths. If omitted, the subprocess inherits the Morphess process working directory. Arguments are passed as an argv array without shell interpolation. Stdio receives the MCP SDK's limited default environment plus explicitly resolved variables, rather than the complete parent environment. Server stderr is discarded to avoid mirroring sensitive diagnostics into logs. Configured commands are trusted host programs and are not process sandboxes.

Servers connect sequentially. Initialization and tool discovery share the server's setup timeout; individual calls also receive a timeout and the invoking Pi context's cancellation signal. A failure closes connections already opened by that load attempt. Runtime shutdown closes clients and transports in reverse order. HTTP redirects are rejected. There is no automatic catalog refresh, connection retry policy, or OAuth flow in Morphess; reopen the runtime after changing server configuration or its tool catalog.

The programmatic connector accepts parsed `McpServerConfig[]` and an optional environment override:

```ts
connectMcpServers(configs, { env: process.env })
// Promise<{ extensions: Extension[]; close(): Promise<void> }>
```

Transport credentials stay in transport memory and are not copied into extension metadata. Servers and plugins can still return sensitive data as tool output, and that output enters durable session history. Keep credentials out of prompts, tool arguments, command arguments, URLs, and returned content.

### Discovery, validation, and output

MCP tools have stable OpenAI-compatible names formed from sanitized server/tool names and a SHA-256 suffix. Use exported `mcpToolName(server, tool)` when embedding an exact name; do not guess the suffix. The original server/tool names appear in the tool description.

Every MCP tool is deferred. The native `tool_search` tool searches enabled deferred tools and returns `control.addTools` so matching tools become available on subsequent model requests. For example, the model can call:

```json
{ "query": "issue-tracker find issue", "limit": 4 }
```

These are arguments to `tool_search`, not a top-level HTTP API request. Loaded declarations remain selected on that conversation branch. Tool availability still follows the conversation's enabled extensions and tools.

Pi validates MCP input schemas through its native TypeBox tool machinery before execution. Malformed arguments fail as tool results without invoking the server. Catalogs are bounded to 10,000 tools and 8 MiB of catalog JSON per server. Individual input schemas are limited to 256,000 JSON characters, and descriptions are truncated to 8,192 characters. These bounds limit declaration storage; the connector does not promise support for every JSON Schema dialect a server might emit.

MCP results expose text and supported image blocks. Embedded text resources become text. Resource links, binary resources, audio, and unsupported blocks produce omission notices; Morphess does not fetch resource URLs automatically. Text output is bounded to 65,536 bytes and 2,000 lines. Images over 12,000,000 base64 characters are omitted. This connector does not expose MCP resource/prompt browsing or map `structuredContent` to a native structured output contract.

All MCP calls use `replay: 'unsafe'`, including tools whose server annotations claim read-only or idempotent behavior. An interrupted call may already have changed external state. After restart, Pi reports that interruption without automatically reissuing the call. Reconcile the external result before deciding whether a new call is appropriate.

## Optional code mode

Set `"codemode": true` to install Pi's durable `codemode` extension. Its `code` argument contains JavaScript executed in a QuickJS VM with a 128 MiB memory limit. The runtime sets `models: false`, so it does not expose direct `models.*` calls to scripts. Scripts have no direct Node, filesystem, network, or timer access; they reach host capabilities through enabled native tools.

For example, the following is the body of a `codemode` call after loading the digest plugin:

```js
const result = await tools.digest_text({ text: 'hello' });
text(result.sha256);
```

Code mode can call enabled deferred MCP tools without first loading their model-facing declarations. Discover script-visible names and argument contracts with `ALL_TOOLS`, `searchTools`, and `describeTool`; use those names when calling `tools.<name>(args)`. Deferred tools are excluded from the initial inline declaration budget. Code mode therefore complements `tool_search`: one discovers tools within a script, while the other loads tool declarations for direct model calls.

Native nested calls validate arguments, retain ownership, and obey their own replay policies. Pi journals deterministic script execution and reattaches nested calls during recovery. Script replay does not authorize replay of an unsafe MCP effect. Code mode itself is model-callable only, so scripts cannot recursively invoke code mode. Host tool execution is bounded by Morphess's shared admission wrapper; avoid unbounded fan-out even though JavaScript supports `Promise.all`.

The VM's limits apply to the script, not to a trusted plugin or MCP subprocess that executes a host capability on its behalf.

## Durable foreground delegation

`delegate` starts a native Pi child conversation and waits for its answer:

```json
{
  "task": "Inspect the parser and report edge cases with file references.",
  "role": "reviewer",
  "timeoutMs": 600000
}
```

`task` must contain 1–200,000 characters. `role` defaults to `researcher`; allowed roles are `researcher`, `reviewer`, and `coder`. `timeoutMs` defaults to 600,000 and accepts integers from 100 through 3,600,000 milliseconds. Successful output is JSON text containing the native numeric `conversationId`, `role`, and textual `answer`; running tool details also expose the child ID and role.

Researcher and reviewer have the same tool restriction: they receive only enabled parent tools named `read`, `ls`, `find`, `grep`, `search`, `glob`, `list_files`, `read_instructions`, `load_skill`, `git_status`, or `git_diff`. Neither role gains missing tools. They do not receive shell, code mode, MCP, or arbitrary plugin tools merely because a description calls them read-only. A coder inherits the parent's enabled tool union, including its enabled deferred tools, with `delegate` removed. Existing tool restrictions and host filesystem policy still apply.

Roles restrict model tool access. They do not sandbox trusted hooks or imported code. Children share the workspace and execution environment; delegation does not create a worktree or isolated filesystem. Assign file ownership explicitly when coders work concurrently.

The relevant configuration is:

```json
{
  "limits": {
    "maxConcurrentAgents": 3,
    "maxAgentDepth": 1
  }
}
```

`maxConcurrentAgents` bounds active delegated calls across the durable session; configuration accepts 1–16. Admission is persisted transactionally. A full limit rejects the new call rather than queuing it. Completed or abandoned task records are pruned from the admission list on later calls.

`maxAgentDepth: 0` disables the tool. Positive values currently permit only one child level, even though the configuration schema accepts values through 16. Every child has the delegation extension removed; setting a larger number does not enable grandchildren. The default is one.

The child conversation belongs to the invoking durable tool task. Aborting the parent call reaches the child through Pi ownership. A timeout explicitly aborts child work, but cannot undo filesystem or remote effects already completed. Closing the harness preserves unfinished durable work for a later open instead of treating shutdown as a user cancellation.

Delegation is replay-safe because a resumed invocation finds its existing task-owned child and submits using a stable request ID derived from the parent tool task. It reattaches to that submission instead of creating another conversation or duplicating the child's input. The original deadline is saved in a durable memo, so downtime consumes the remaining timeout. Child tools continue to obey their individual replay policies. This foreground implementation does not provide independently persistent background workers or a multi-level agent hierarchy.
