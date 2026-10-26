# Configuration and operation

## Configuration

Run `morphess init` in the target workspace, then edit `morphess.json`. Use `morphess -C <directory> -c <file>` to select a workspace/configuration location. An explicitly named missing configuration file is an error.

Nested `model`, `policy`, `limits`, `context`, and `server` objects merge over defaults. Unknown fields fail validation. Relative workspace/state paths and MCP working directories resolve against the selected configuration file; plugin paths resolve against the workspace. Environment files are not loaded automatically.

| Setting | Behavior |
| --- | --- |
| `model.baseUrl` | API base URL, normally including `/v1`, without a completion path |
| `model.id` | Exact endpoint model ID |
| `model.api` | `chat-completions` or `responses` |
| `model.apiKeyEnv` | Name of the credential environment variable |
| `model.contextWindow` / `maxOutputTokens` | Supported input-window and output limits |
| `model.input` | Text, or text and image input |
| `model.timeoutMs` / `idleTimeoutMs` | Hard request and stream-inactivity deadlines |
| `model.maxRetries` | Provider retries; durable transient retries remain separately bounded |
| `model.allowUnauthenticated` | Explicitly permit a keyless endpoint |
| `codemode` | Enable native QuickJS tool composition; defaults to `true` |
| `plugins` / `mcp` | Explicit trusted plugin imports and MCP connections |

Environment overrides are `MORPHESS_BASE_URL`, `MORPHESS_MODEL`, `MORPHESS_API`, and `MORPHESS_API_KEY_ENV`. The last contains a variable name, not the credential itself.

Chat Completions compatibility settings are `supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, and `maxTokensField` (`max_tokens` or `max_completion_tokens`). Responses accepts the developer-role setting. Enable `reasoning` only when the endpoint supports it.

`morphess doctor` reports resolved configuration and credential presence without contacting the model. `morphess tools --all --json` reports the installed catalog; `morphess tools <name> --session <id>` reports a specific tool and its session availability. See [MCP configuration](mcp.md) and [plugin contracts](extensions.md).

## Permissions

| Policy | File reads | File mutations | Arbitrary shell |
| --- | --- | --- | --- |
| `read-only` | Workspace | Denied | Denied |
| `workspace-write` | Workspace | Workspace | Denied |
| `trusted` | Workspace through file tools | Workspace through file tools | Host authority |

Use `morphess --trusted run <task>` only when host command execution is intended. The policy rejects traversal, outside paths, escaping/dangling symlinks, state-directory access, file-tool writes under `.git`, nonregular-file access, and hardlink mutation. Reads and output are bounded.

Guarded Git/ripgrep capabilities use fixed host executables rather than workspace-controlled PATH entries. The portable file-search fallback does not implement gitignore semantics. Guarded Git helpers require metadata inside the workspace and do not support linked worktrees.

The configured state directory and `.morphess` are protected. Temporary tool output uses `.morphess-tmp`. Filesystem checks are defense in depth against ordinary tool mistakes; they are not an OS sandbox. Trusted plugins and MCP executables can access the host directly. Use an external isolation boundary for untrusted code.

Plan mode further narrows agent tools without changing host policy. Stop active work before entering plan mode. Build mode restores prior known tool names and does not grant additional shell authority.

## Persistence and recovery

SQLite is stored at `<stateDir>/session.sqlite`; directory/file modes are 0700/0600. Treat session databases, image artifacts, and `ui.json` as sensitive because they contain user input and tool results.

Only one host process may own a state directory. Clean close releases the writer lock. After an unclean process exit, stale-lock recovery normally waits approximately 120 seconds plus filesystem timestamp precision. Do not remove a live writer's lock. Custom `RuntimeOptions.writerLock` intervals require enough allowance for event-loop pauses.

`morphess resume` resumes pending work and waits for idle. Host close preserves accepted work; explicit abort cancels its ownership subtree. A client disconnect cancels its wait rather than the accepted task. Interrupted unsafe calls become interrupted results; completed side effects are not replayed automatically.

Pi parks a task after five interrupted restarts at one checkpoint. Inspect tasks through `/v1/tasks`; library hosts can call `harness.retryTask` or `abortTask` after diagnosing the cause.

SQLite WAL/NORMAL tolerates process crashes but does not guarantee preservation of the latest commits after power loss. Stop the host before copying the database and WAL files, or use an SQLite-aware backup. Copying an active database file alone is insufficient.

## Request and cost limits

`limits.maxTurns` bounds model request attempts per run, including retries and compaction. Child runs have separate counters. `limits.maxConcurrentAgents` bounds delegated calls; child depth is currently one, with `maxAgentDepth: 0` disabling delegation.

Configure model prices in dollars per million tokens before enabling `limits.maxSpendUsd`:

```json
{
  "model": {
    "cost": { "input": 1, "output": 3, "cacheRead": 0.1, "cacheWrite": 1 }
  },
  "limits": { "maxSpendUsd": 20 }
}
```

Replace these rates with the endpoint's actual prices. Admission reserves the full window and output at conservative rates; confirmed usage settles unused capacity. Missing usage retains the reservation across restarts. Price changes do not reprice earlier reservations, and external-service charges are outside this ceiling. `/v1/usage` exposes reported usage; the reservation ledger also accounts for in-flight and uncertain calls.

Prompt caching depends on the inference endpoint. Stable prompt sections and declaration order preserve cacheable prefixes, but configuration does not guarantee a cache hit rate. Inspect provider-reported cache counters when measuring the configured endpoint.

## Attachments

Input supports up to 16 PNG/JPEG/GIF/WebP images, each at most 4 MiB and at most 16 MiB total. Header signatures and dimensions are checked before submission. Content-addressed copies are kept in `<stateDir>/artifacts`, and image blocks remain in the native transcript.

Native model blocks support text/images. OpenAI per-image `detail: low/high` is rejected because those semantics cannot be preserved; use `auto` or omit it.

## HTTP hosting

```sh
morphess serve --host 127.0.0.1 --port 8787
```

Set the environment variable named by `server.tokenEnv` to require bearer authentication. Binding beyond loopback requires it. Except minimal `/health`, configured authentication applies to host routes. The token authorizes the complete host, not an individual tenant. Browser Origin requests are rejected. Use TLS and an external identity boundary when exposing the host beyond a trusted environment.

Bodies are limited to 24 MiB, requests/connections to 64, and streams to 32. Slow SSE clients disconnect after 30 seconds of backpressure. Reattach to snapshots and paginate committed history. See the [API reference](api.md).

## Human questions

Terminal and HTTP hosts can answer durable questions, including active child questions. Batch `run` and line-oriented `chat` direct new questions to final text because they do not expose a durable answer interface. Previously persisted questions remain pending; reopen the terminal or answer through HTTP to settle them. `resume` can remain waiting for that input.

A question answer does not grant shell, plugin, or external-service authority. Optional question deadlines persist through downtime. Terminal drafts/history are stored atomically in mode-0600 `ui.json`; see [terminal controls](tui.md).
