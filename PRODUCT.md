# Morphess

<!-- impeccable:product-schema 1 -->

## Platform

Terminal application on macOS/Linux, with a headless CLI and HTTP API. This is a terminal surface, not a website or native mobile application.

## Users and Purpose

Developers running durable coding tasks with their own OpenAI-compatible model. The user requested a powerful coding harness, a polished TUI, multimodal Chat Completions, and a one-million-token context profile.

## Operating Context

Morphess extends Pi Durable and retains its conversations, task scheduler, tool intents, and replay policy. The private repository is Belweave/morphess. Existing CLI/API workflows remain available.

The user confirmed that a focused coding session leads, with an optional session/tool sidebar.

## Brand Commitments

The user explicitly requested the official morphllm.com logo as green ASCII art at TUI launch. Bundle the verified source asset and record provenance; do not invent a substitute logo. OpenTUI is the requested framework to investigate. Take a few useful patterns from ~/Code/pk, without transplanting that project's engine or full interface.

Morphess is an independent, unofficial harness designed to work with Morph inference. It is not developed, endorsed, sponsored, or backed by Morph. Logo use identifies the intended inference provider and does not imply affiliation.

## Capabilities and Constraints

Shipped baseline: durable SQLite recovery, text/image model input, coding tools, task-owned subagents, MCP, code mode, plans/notes, execution policies and resource limits. Model endpoint/id and live credentials remain user configuration. Native message types beyond text/images remain an open extension, not an established capability.

## Product Principles

- Working behavior and recoverable state take precedence over presentation claims.
- Keep activity and uncertainty visible without overwhelming the conversation.
- Preserve keyboard access, readable narrow layouts and bounded rendering work.
- Never fabricate model quality, operational success, or completed tool results.
