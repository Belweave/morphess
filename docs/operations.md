# Operation and limits

## Configuration

Use `node dist/cli.js init` or copy `morphess.example.json`. Nested model, policy, limits, context, and server settings merge over defaults; unknown fields fail. Relative workspace/state/MCP working-directory paths resolve against the selected config file. Missing explicit config files fail.

Environment overrides: `MORPHESS_BASE_URL`, `MORPHESS_MODEL`, `MORPHESS_API`, `MORPHESS_API_KEY_ENV`. The last names the credential variable. Environment files are not automatically loaded.

`model.api` defaults to `chat-completions`, with `responses` also available. Include the API prefix (usually `/v1`) in `baseUrl`, not the full completion path. Arbitrary model IDs register directly without public catalog discovery.

Chat compatibility flags are `supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, and `maxTokensField` (`max_tokens` or `max_completion_tokens`). Responses uses the developer-role flag and does not reinterpret Chat options. Enable `reasoning` only for a compatible endpoint.

`maxOutputTokens` caps the final provider payload, including after hooks. `timeoutMs` is a hard request deadline; `idleTimeoutMs` caps native stream inactivity. Provider retries default to zero; Pi permits two durable transient-error retries with backoff. All admitted attempts count toward `maxTurns`.

## Authority

| Mode | File reads | File mutations | Arbitrary shell |
| --- | --- | --- | --- |
| read-only | Workspace | Denied | Denied |
| workspace-write | Workspace | Workspace | Denied |
| trusted | Workspace through file tools | Workspace through file tools | Full host authority |

The environment rejects traversal, outside absolute paths, escaping/dangling symlinks, state-directory access, and file-tool mutations under `.git`. Narrow read capabilities use fixed absolute host Git/ripgrep executables, not workspace-controlled PATH binaries. Search has a portable bounded fallback. Linked Git worktrees are unsupported by guarded Git helpers.

The configured state directory and `.morphess` are protected; tool temp output lives in `.morphess-tmp`. A hostile concurrent filesystem process can race path checks, so this is defense in depth. Trusted ESM plugins and MCP executables can access the host independently of file-tool policy. Use an external container/VM boundary for untrusted code.

## Persistence

SQLite lives at `<stateDir>/session.sqlite`. The directory is mode 0700 and database file 0600. Sessions can contain source, prompts, images and tool output. Credentials are not deliberately persisted, but arbitrary tool/user content can still contain secrets; comprehensive secret redaction is not claimed.

One process owns a state directory. Clean close releases the writer lock. After SIGKILL, allow approximately 120 seconds plus timestamp precision for stale-lock recovery. Never remove a live writer's lock. Managed hosts/tests can tune `RuntimeOptions.writerLock`; short intervals risk false takeover during event-loop stalls.

`resume` waits for pending work; `serve` also resumes on open. Pi retries interrupted model requests. Replay-safe calls can reattach/replay, while unsafe in-flight calls become interrupted results. Committed completed effects are not repeated. A replay-safe external tool still needs its own idempotency.

Pi parks a task after five interrupted restarts at one checkpoint. Inspect through `/v1/tasks`; library hosts can diagnose and call `harness.retryTask` or `abortTask`. There is no CLI repair command yet.

Host close preserves resumable work. Explicit session abort stops its ownership subtree. HTTP disconnect cancels only the waiter. CLI SIGINT requests root cancellation; use the session abort API for an explicitly selected different session. `serve` handles SIGTERM.

SQLite WAL/NORMAL protects against process crashes but may lose latest commits on power/machine failure. Stop the host before copying the database with its WAL files, or use an SQLite-aware backup. Copying an active database file alone is insufficient.

## Budgets

`maxTurns` caps request attempts per run, not lifetime tokens. Retries/compaction count. Child runs have their own counters and shared session cost reservations.

Model-spend admission requires configured prices in dollars per million tokens:

```json
{
  "model": { "cost": { "input": 1, "output": 3, "cacheRead": 0.1, "cacheWrite": 1 } },
  "limits": { "maxSpendUsd": 20 }
}
```

These numbers illustrate configuration, not actual prices. Admission reserves the full input window plus output at the largest applicable input rate. It may reject a small prompt with insufficient worst-case capacity. Confirmed usage releases unused capacity; absent usage retains it across restarts. No automatic unknown-charge refund/reset command is shipped. Changing prices does not reprice previous reservations. Paid plugin/MCP services are outside this model-call ceiling.

`/v1/usage` exposes Pi's reported usage; the cost-reservation ledger additionally accounts for in-flight/uncertain calls. Correct rate configuration and trustworthy provider usage remain necessary.

## Attachments and serving

The CLI accepts up to 16 PNG/JPEG/GIF/WebP images, each at most 4 MiB. Content-addressed copies are stored in `<stateDir>/artifacts`; image blocks also remain in Pi's transcript. This is not complete transcript blob offloading. Native image reads apply Pi's image limits. Audio/video/PDF native model blocks are unsupported.

Default HTTP is `127.0.0.1:8787`. A non-loopback bind requires the environment token named by `server.tokenEnv`. Except minimal `/health`, routes require that token when configured. Browser Origin requests are rejected; this is a headless API without CORS UI. Add TLS and external identity controls for exposure beyond a trusted environment. The token authorizes the entire host, not an individual tenant.

Bodies are limited to 24 MiB, requests/connections to 64, streams to 32. Slow SSE consumers disconnect after a 30-second backpressure wait. Reattach to control snapshots and paginate committed history. Native Pi event types are experimental.

## Evaluation

`npm run check` typechecks, tests offline with two workers, and builds. `npm run eval` drives the compiled CLI against a scripted local Chat endpoint and verifies a real coding-tool result. `MORPHESS_EVAL_LARGE=1 npm run eval` adds a multi-megabyte prompt. These demonstrate harness behavior, not live coding quality or advertised 1M-token reasoning.
