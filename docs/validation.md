# Validation record

Local verification on 2026-10-26 used Node v26.12.1 and npm 12.2.0, with two Vitest workers and temporary disk-backed sessions.

| Check | Result |
| --- | --- |
| `npm run check` | Strict TypeScript, 145 tests in 20 files, distributable compilation passed |
| Headless Node v22.23.4 | 131 tests passed; the 14 native OpenTUI cases skipped as intended |
| Offline compiled CLI | Local Chat Completions SSE → real write tool → verified file; two model requests, 305 ms |
| Large offline CLI | Same flow passed with 2,975,043 prompt bytes; largest provider payload 2,985,508 bytes; 335 ms |
| Recovery | Actual SIGKILL during an unsafe external effect; SQLite reopened, interrupted result preserved, effect count stayed one |
| Compatibility | Local fixtures exercised Chat Completions and Responses, streamed tool JSON, images, output ceilings, hard/idle deadlines and cancellation |
| Integration | Native code mode, stdio/HTTP MCP, durable child recovery, execution caps, budget reservations, policy boundaries and SSE backpressure |
| Questions | Freeform/options, concurrent questions, owning-task abort, timeout, SQLite reopen, child routing, native HTTP answers and retry/error contracts |
| Native terminal | Real OpenTUI rendering at 120×36 and 60×20, keyboard submit/newline/palette, startup mark, full question view, themes, draft retention, stable Markdown nodes and cleanup |
| Plan mode | Exact prior tools/modelTools restored; active build work must stop first; headless reopen preserves restrictions; delegated coder write attempt denied |
| Real PTY smoke | Compiled launcher re-executed with native FFI, opened offline demo, ran read/ask_user, received answer, rendered Markdown and exited with Ctrl+Q/code 0 |
| Brand | Generated green ASCII from bundled official documentation SVG; startup uses no branding network request; persistent unofficial/independent notice |
| UI design scan | Impeccable detector reported no findings for `src/tui`; native captures inspected at wide and narrow sizes |

The CLI checks run `node --import tsx scripts/eval.ts` after compilation, with `MORPHESS_EVAL_LARGE=1` for large mode. `npm run eval` builds first and invokes the same script. These results reflect fixture transport/tool overhead, not inference speed. No external model, paid endpoint, live credentials, real coding benchmark, or exact million-token input was used.

## Stream bookkeeping benchmark

Reproduce with `npm run benchmark:stream` on a Node process with exposed GC. For 100,000 fulfilled synthetic operations, the shared pending-abort-promise pattern retained 25,690,304 bytes and took 47 ms; cleanup-aware abort racing retained 99,832 bytes and took 28 ms on this machine. This isolates abort bookkeeping, not network throughput or total session memory. GC and timing results vary. The adapter now uses the cleanup-aware primitive, and native view tests verify completed transcript nodes survive unrelated updates.

## Documentation captures

`node --experimental-ffi --import tsx scripts/capture-tui.ts` drives the real runtime with Pi's faux provider in a temporary workspace and rasterizes native renderer cell captures. [Welcome](screenshots/welcome.png), [coding](screenshots/coding.png), and [narrow question](screenshots/question-narrow.png) are offline-demo evidence, not live model output. They contain no real user session payloads.

## Remote CI

GitHub Actions is configured for Node 22.19.0, 24, and 26 on Linux. The prior run [40311658095](https://github.com/Belweave/morphess/actions/runs/40311658095) did not start runners: GitHub reported an account payment/spending-limit restriction. Local checks above passed; remote CI is not represented as passing. Account billing changes require the repository owner's action.
