# Validation record

Local verification on 2026-10-26 used Node v26.12.1 and npm 12.2.0, with two Vitest workers and temporary disk-backed sessions.

| Check | Result |
| --- | --- |
| `npm run check` | Strict TypeScript, 73 tests in 14 files, distributable compilation passed |
| `npm run eval` | Compiled CLI → local Chat Completions SSE → real write tool → verified file; two model requests |
| `MORPHESS_EVAL_LARGE=1 npm run eval` | Same flow passed with 2,975,043 prompt bytes; largest provider payload 2,983,971 bytes |
| Recovery | Actual SIGKILL during an unsafe external effect; SQLite reopened, interrupted result preserved, effect count stayed one |
| Compatibility | Local fixtures exercised Chat Completions and Responses, streamed tool JSON, images, output ceilings, hard/idle deadlines and cancellation |
| Integration | Native code mode, stdio/HTTP MCP, durable child recovery, execution caps, budget reservations, policy boundaries and SSE backpressure |

The scripted CLI evaluations completed in approximately 0.3 seconds on this machine; that reflects fixture transport/tool overhead, not model inference speed. No external model, paid endpoint, live credentials, real coding benchmark, or exact million-token input was used.

GitHub Actions is configured for Node 22.19.0, 24, and 26 on Linux. Its remote results are separate from the local results recorded here.
