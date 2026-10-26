# Morphess

Morphess runs durable coding tasks against a configured OpenAI-compatible inference endpoint. It uses Pi Durable for conversations, tool execution, SQLite recovery, and task ownership, with a terminal UI, CLI, and HTTP API.

**Morphess is an independent, unofficial harness for Morph inference. It is not developed, endorsed, sponsored, or backed by Morph.**

## Install from this checkout

The terminal requires Node 26.4+ on macOS or Linux. Headless commands and library use require Node 22.19+.

```sh
npm ci --ignore-scripts
npm run check
npm pack
npm install --global ./belweave-morphess-0.2.1.tgz --omit=dev --ignore-scripts
export PATH="$(npm prefix --global)/bin:$PATH"
morphess --version
morphess --help
```

Keep the npm global prefix's `bin` directory on your shell's PATH. Rebuild, pack, and install again after updating the checkout.

## Configure

From the project you want to work on:

```sh
morphess init
```

Edit `morphess.json` with your real endpoint and model ID. For example:

```json
{
  "model": {
    "baseUrl": "https://api.morphllm.com/v1",
    "id": "morph-kimik3",
    "api": "chat-completions",
    "apiKeyEnv": "MORPH_API_KEY",
    "contextWindow": 1000000,
    "maxOutputTokens": 32768,
    "input": ["text", "image"]
  }
}
```

Set the environment variable named by `model.apiKeyEnv` to your endpoint credential. For an explicitly unauthenticated local endpoint, set `model.allowUnauthenticated` to `true`. Set context and output limits to values supported by your model.

```sh
morphess auth login
morphess doctor
morphess
```

`doctor` checks configuration and credential presence; it does not send an inference request. The default configuration enables code mode and permits workspace file edits while denying arbitrary shell execution.

## Commands

```sh
morphess tui --session root
morphess menu
morphess tools --all
morphess tools read --json --session root
morphess run "Inspect this repository and explain the parser"
morphess run "Implement the attached layout" --image ./layout.png --json
morphess --trusted run "Fix the parser and run its tests"
morphess sessions
morphess usage --json
morphess export root
morphess fork root 123
morphess resume
morphess serve --port 8787
```

Use `morphess --help` for command groups and `morphess <command> --help` for arguments and examples. `-C <directory>` selects a workspace; `-c <file>` selects a configuration file. `run --events` emits durable JSONL events; `run --request-id <key>` deduplicates admission within a conversation.

`--trusted` permits commands to execute with the host process's authority. File-tool checks and code mode do not isolate host shell execution. Use a separate container or VM when host isolation is required.

## Tools and interfaces

| Capability | Tools or interface |
| --- | --- |
| Workspace files | `read`, `read_bytes`, `write`, `edit`, `list_files`, `search` |
| Commands and Git | `bash`, `git_status`, `git_diff` |
| Project guidance | `read_instructions`, `load_skill` |
| Working state | `update_plan`, `remember` |
| Human input | `ask_user`; terminal and authenticated HTTP answers |
| Delegation | `delegate` with researcher, reviewer, or coder role |
| Programmatic calls | `codemode` over enabled tools; `tool_search` for deferred declarations |
| Extensions | Explicit trusted ESM plugins and configured MCP servers |
| Integration | Native session API, SSE events, OpenAI-compatible chat gateway |

Run `morphess tools --all --json` for the installed catalog and `morphess tools <name> --session <id>` for a tool's schema and availability. Shell and filesystem policy also apply to code mode and delegated calls. Code mode does not expose direct model APIs.

One host process owns each `stateDir`. Closing the terminal preserves accepted work; aborting cancels the selected task subtree. Session storage contains prompts, source, attachments, and tool results and must be treated as sensitive.

- [Provider configuration and credentials](docs/providers.md)
- [Terminal controls](docs/tui.md)
- [Configuration, permissions, recovery, and limits](docs/operations.md)
- [Plugin, code mode, and delegation contracts](docs/extensions.md)
- [Cache configuration and usage](docs/cache.md)
- [MCP configuration and capabilities](docs/mcp.md)
- [HTTP API](docs/api.md)
- [Runtime architecture](docs/architecture.md)
- [Verification commands](docs/validation.md)

Morphess code is proprietary. Dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
