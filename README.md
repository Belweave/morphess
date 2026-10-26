<img src="assets/icon.svg" width="64" height="64" alt="">

# Morphess

A durable coding-agent harness for OpenAI-compatible models, built directly on **Pi Durable 1.4.0**. The default profile uses **Chat Completions, text/image input, and a 1,000,000-token context window**. Model ID, endpoint, output budget, prices, and compatibility flags are configurable.

**Morphess is an independent, unofficial harness designed to work with Morph inference. It is not developed, endorsed, sponsored, or backed by Morph.** Its name and use of Morph's logo identify the intended inference provider; they do not imply affiliation.

Morphess runs the agent around your inference endpoint; it does not serve model weights. Version 0.2 adds a native OpenTUI coding workspace to the tested durable runtime. Live performance with your special model still needs to be measured.

## Start

The full terminal experience requires **Node 26.4 or later**, macOS or Linux, and npm. Headless CLI/API/library use supports Node **22.19.0 or later**. OpenTUI currently uses Node's experimental FFI; the launcher enables it in a child process before opening storage.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js init
```

Edit `morphess.json` with your endpoint and model ID. Set the environment variable named by `model.apiKeyEnv` (default `MORPHESS_API_KEY`). For a deliberately keyless local server, set `model.allowUnauthenticated` to `true`. Credentials belong in the environment.

```sh
node dist/cli.js doctor
node dist/cli.js
node dist/cli.js run "Inspect this repository and explain its architecture"
```

Try the complete terminal without credentials or a configured provider:

```sh
npm run tui:demo
```

This uses a temporary workspace and a scripted local provider, real file tools, durable questions, and no inference requests. See the [terminal guide](docs/tui.md) for shortcuts, themes, attachments, plan mode, and recovery.

![Morphess native terminal: independent harness, green Morph ASCII emblem, focused composer](docs/screenshots/welcome.png)

The default `workspace-write` policy permits workspace file edits and denies arbitrary shell execution. To run tests/builds through the agent's shell on a repository you trust:

```sh
node dist/cli.js --trusted run "Implement the requested change and run its tests"
```

`--trusted` grants host shell access. Filesystem checks and QuickJS code mode do not isolate that shell from your machine. Run the entire host in an independently isolated container/VM for untrusted workloads.

## Included

| Capability | Implementation |
| --- | --- |
| Durable execution | Pi conversations, checkpoints, submissions, tool intents, SQLite recovery and explicit replay policies |
| Model compatibility | Native Chat Completions/Responses adapters; custom IDs, streaming tools, output caps, cancellation, hard/idle deadlines |
| Long context | 1M profile, output reserve, usage-anchored estimates, native compaction, stable prompt sections, bounded output |
| Coding | Read/write/edit/bash, bounded binary reads, search/listing, guarded Git status/diff, regular-file/hardlink checks and protected state |
| Delegation | Task-owned researcher/reviewer/coder children; concurrency caps, deadlines, cancellation, restart deduplication |
| Programmatic tools | Optional QuickJS code mode with journaled nested calls and policy enforcement |
| Extensions | Trusted ESM plugins; stdio/HTTP MCP, deferred discovery, schema validation and lifecycle cleanup |
| Working memory | Fork-aware plans and keyed notes retained through compaction |
| Terminal | Native OpenTUI, streaming Markdown, multiline editor, searchable commands/sessions/tools/files, draft recovery, three themes and optional inspector |
| Human input | Durable freeform questions, suggested choices, child-question routing and native HTTP answer API |
| Interfaces | TUI, line-oriented chat, CLI, JSONL events, native session API, SSE and OpenAI-compatible chat gateway |
| Resource controls | Writer locking, bounded execution, persisted request caps and conservative model-cost reservations |

The design combines Pi's durable core with ideas studied in DeepSeek Harness: replaceable capabilities, explicit plugin lifecycles, role-scoped tools, progressive disclosure, and guarded execution. DeepSeek's separate runtime is not embedded. See [architecture and research](docs/architecture.md) for pinned sources and decisions.

## Use

```sh
node dist/cli.js -C /path/to/project -c morphess.json run "Fix the failing parser"
node dist/cli.js run "Implement this screenshot" --image /path/to/screenshot.png --request-id design-1 --json
node dist/cli.js run "Inspect the project" --events
node dist/cli.js resume
node dist/cli.js sessions
node dist/cli.js export root
node dist/cli.js fork root 123
node dist/cli.js serve --port 8787
```

Run one CLI/HTTP host per `stateDir`. Multiple clients attach through the HTTP API. Disconnect cancels a client's wait; accepted work remains durable until explicitly aborted.

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: architecture-1' \
  -d '{"model":"your-model-id","stream":true,"messages":[{"role":"user","content":"Explain the architecture"}]}'
```

Set `MORPHESS_SERVER_TOKEN` to require bearer authentication. Binding beyond loopback requires it. See [API reference](docs/api.md), [operation and limits](docs/operations.md), and [extensions/MCP](docs/extensions.md).

## Verify

```sh
npm run check
npm run eval
MORPHESS_EVAL_LARGE=1 npm run eval
npm run benchmark:stream
```

Tests use Pi's faux provider, local OpenAI SSE/MCP fixtures, temporary SQLite databases, an actual SIGKILL subprocess, and OpenTUI's native renderer and keyboard simulation. Native terminal tests run on Node 26.4+ and skip on older headless runtimes. The eval drives the compiled CLI through a local endpoint and verifies a real file tool result. Large mode transports a multi-megabyte input. These evaluate harness mechanics, not live model intelligence or the model's true 1M-token capacity.

Current boundaries: text/images only, one child-agent level, no browser UI, LSP/ACP, background teams, MCP OAuth/reconnect, or OS sandbox backend. The downstream chat gateway supports an explicit subset and owns its tools. These limits are documented rather than silently emulated.

Repository: **private `Belweave/morphess`**. Morphess code is proprietary; upstream MIT notices are retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
