# Verification

From the source checkout:

```sh
npm ci --ignore-scripts
npm run check
npm run eval
MORPHESS_EVAL_LARGE=1 npm run eval
npm run benchmark:stream
```

`check` runs strict TypeScript checks, tests with two workers, and a distributable build. Tests use Pi's test provider, local HTTP/MCP fixtures, temporary workspaces, and disk-backed SQLite sessions. They do not require external inference credentials.

| Area | Coverage |
| --- | --- |
| Model transport | Chat Completions/Responses, streamed tool arguments, images, output limits, hard/idle deadlines, cancellation |
| Durable execution | SQLite reopening, request deduplication, actual process termination, interrupted unsafe effects |
| Tools and policy | Direct/nested/delegated calls, filesystem boundaries, protected state, bounded reads/search, concurrency and cost reservations |
| Human questions | Freeform/choice input, retries, cancellation, deadlines, restart recovery, child routing and HTTP answers |
| Terminal | Native wide/narrow rendering, keyboard actions, draft retention, themes, stable rows, control-sequence filtering and cleanup |
| Plan mode | Exact tool/modelTools restoration, active-work checks, headless reopening and denied delegated writes |

Native terminal tests require Node 26.4+ and are skipped on older headless runtimes. The terminal test launcher enables native FFI only for the supported process.

`eval` drives the compiled CLI against a local Chat Completions fixture and verifies a file-tool result. Large mode adds a multi-megabyte prompt. `benchmark:stream` measures cancellation bookkeeping with exposed GC; it does not measure inference throughput.

Local fixture results do not establish remote model quality, provider cache hit rates, or advertised context-window capacity. Validate those measurements against the endpoint configured in `morphess.json`.

## Installed artifact

```sh
npm pack
npm install --global ./belweave-morphess-0.2.2.tgz --omit=dev --ignore-scripts
export PATH="$(npm prefix --global)/bin:$PATH"
morphess --version
morphess --help
morphess tools --help
morphess init
morphess doctor
```

Run `init` in a separate target workspace; it refuses to overwrite an existing configuration. Configure a real endpoint/model before submitting inference work. `doctor` validates configuration and credential presence without sending a request.

The installed executable must resolve through npm's global `morphess` symlink. Headless help and diagnostics must work without loading OpenTUI or enabling native FFI.
