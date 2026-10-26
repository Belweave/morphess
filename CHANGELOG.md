# Changelog

## 0.2.3 — 2026-10-26

- Added authenticated `/models` discovery, a searchable TUI model picker, manual IDs, refresh/cancellation, profile review, and the `models` CLI command.
- Persisted native per-session model selection and restored selected profiles before scheduling; applied selected capacity, modalities, output limits, and compaction settings.
- Added Shift+Tab mode cycling and an explicit mode selector; renamed the Build label to Code while retaining `/build` as an alias.
- Put model/mode actions first in the command menu and documented the separate `codemode` tool.

## 0.2.2 — 2026-10-26

- Fixed `auth login` staying alive after saving a key by releasing terminal input when no reader was active before entry.
- Disabled terminal echo before displaying the API key prompt, including immediate paste input.
- Added regression coverage for unused input, existing readers, and natural process exit without stdin EOF.

## 0.2.1 — 2026-10-26

- Added production artifact installation with an executable npm global CLI and symlink-aware entrypoint detection.
- Added grouped root help, command-specific examples, the command menu, and session-aware tool catalog/schema inspection.
- Set Morph's endpoint and 1M text/image model as defaults; added configurable providers and masked, endpoint-scoped credential storage.
- Enabled code mode by default for registered capabilities while retaining tool policy, durable nested execution, and model-call admission controls.
- Added MCP 2026-07-28 negotiation, resource/prompt operations, OAuth management, durable task handles, verified skills, elicitation, and approved sampling; documented extension limits.
- Stabilized outgoing tool order, exposed cache retention settings and reported cache usage, and added paused session inspection.
- Fixed command palette selection when a search query and Enter arrive in the same terminal input batch.
- Removed test-only provider entrypoints and public capture assets.
- Updated installation, configuration, operation, extension, and terminal reference documentation.

## 0.2.0 — 2026-10-26

- Added the native OpenTUI workspace, streaming Markdown, multiline input, searchable selectors, private drafts/history, themes, and optional inspector.
- Added durable human questions, child-question routing, and authenticated HTTP answers.
- Added plan/build restrictions with exact tool restoration and headless recovery.
- Hardened cancellation, request admission, SSE cleanup, regular-file access, protected state, binary reads, and image validation.
- Added native terminal, transport, policy, concurrency, and recovery tests.

## 0.1.0

- Added durable coding tasks, SQLite recovery, text/image model input, plugins, MCP tools, and task-owned delegation on Pi Durable 1.4.0.
