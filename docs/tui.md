# Terminal workspace

Open the terminal with `morphess` or `morphess tui --session <id>`. Node 26.4+ and an interactive terminal are required. The launcher enables Node's experimental FFI before loading OpenTUI; headless commands do not load it.

Morphess is independent, unofficial, and not developed, endorsed, sponsored, or backed by Morph.

## Navigation

The workspace contains a transcript, multiline composer, and status controls. The optional context/plan inspector appears at widths of at least 110 columns. Command, session, tool, and file selectors are keyboard-searchable. Use `morphess menu` to open the CLI command menu and `morphess --help` for command reference.

| Key | Action |
| --- | --- |
| Enter | Send input or answer the current question |
| Shift+Enter / Alt+Enter | Insert a newline, subject to terminal support |
| Shift+Tab | Cycle Code and Plan modes |
| Ctrl+P | Open the command menu |
| Ctrl+O / Ctrl+N | Switch / create a session |
| Ctrl+B | Toggle the context/plan inspector |
| Ctrl+T | Inspect tool activity |
| Ctrl+R | Open the complete pending question and suggested answers |
| Ctrl+Y | Request clipboard copy of selection or the last answer |
| Ctrl+U | Clear the composer |
| Up / Down | Recall input history when the composer is empty |
| PageUp / PageDown | Scroll the transcript or detail view |
| Escape | Close a menu; otherwise stop active work |
| Ctrl+C | Stop active work; quit when idle |
| Ctrl+Q | Quit while preserving recoverable work |

Clipboard copy uses OSC52 in response to an explicit action and requires terminal support. Terminal settings control fonts, character size, and keyboard encoding.

## Session actions

Available commands include `/new`, `/sessions`, `/fork [entry]`, `/compact`, `/abort`, `/diff`, `/tools`, `/catalog`, `/provider`, `/files [query]`, `/attach <path>`, `/theme [forest|light|contrast]`, `/thinking`, `/answer <text>`, `/help`, and `/quit`.

A session keeps its own draft. Switching sessions detaches its UI observers while native work continues. Quitting preserves accepted work for a subsequent host. Explicit abort stops the selected ownership subtree. `/fork` uses the latest committed assistant entry unless an entry ID is supplied.

Pending `ask_user` questions survive close/reopen. Questions from active delegated agents appear in their parent's view. Enter a suggested number or a freeform answer; an answer does not change execution permissions. `/thinking` shows retained reasoning only when the provider supplies it.

File selection inserts an `@path` reference; file tools retrieve its contents. Image attachments are validated and loaded when input is submitted. A failed submission retains the draft.

## Models

Use `/model` or **Ctrl+P → Choose model**. Morphess authenticates `GET <baseUrl>/models` with the configured provider key. The searchable list is cached in memory for 60 seconds; **Refresh model list** bypasses it. Escape cancels loading. Discovery failures offer retry, manual model ID entry, and provider settings.

Morph's ID-only authenticated roster is enriched from its official public metadata endpoint at `https://www.morphllm.com/api/models/json`. That request receives no API key and cannot add models absent from the account roster. If enrichment is unavailable, the picker retains the roster and labels missing capabilities.

Select a model, review its profile, and choose **Use in this session**. Explicit provider limits and text/image modalities are used when reported; missing fields inherit your configured profile and are labelled during review. Output remains capped by your configured ceiling. Prices from another model are never copied. Hosts with a spend limit require explicit prices before switching to another model.

The session's model and selected profiles persist in Pi's state and restore before scheduling resumes. Stop active work before switching; a smaller context or incompatible image history can require compaction or a new session. New submissions use the selected model. `/model <id>` supports manual IDs; `morphess models --json` lists models from the CLI. `morphess configure --model <id>` changes the launch default. Endpoint and protocol changes require a host restart.

## Code and Plan modes

Use **Shift+Tab**, `/mode`, or **Ctrl+P → Change mode**. The header and composer show the current mode. Code is the default editing workflow; it was previously labelled Build.

`/plan` restricts tools to reads, search, guarded Git inspection, guidance, human questions, working notes/plans, and restricted delegation. Stop active work before entering plan mode. Shell, file mutation, code mode, and deferred-tool loading are excluded.

`/code` restores the previous enabled tool names that still exist in selected extensions; `/build` remains an alias. It preserves model-facing tool filters. A delegated child inherits the parent's restricted tools and cannot enable missing tools. Workspace policy continues to apply in both modes; switching to Code does not grant shell access.

The `codemode` tool is a JavaScript sandbox for calling enabled tools through `tools.*`. It is installed by default, available in Code, and excluded by Plan's read-only selection. It is a tool, separate from the workflow selector. `/codemode` explains its status and `/catalog` shows its parameters.

Mode and restoration data are committed together with the native tool filter. Restrictions persist when the same session is reopened from another interface.

## Display and storage limits

The terminal projects the most recent 80 entries, up to 24,000 characters per message and 64,000 per tool detail. It removes terminal control sequences from displayed content while preserving original source in Pi's transcript. Export full history with `morphess export <session>` or use the paginated API.

Native event/document watches coalesce updates every 40 ms. Unchanged completed rows retain renderable identity. The UI does not run a separate execution loop.

Private `<stateDir>/ui.json` stores theme, inspector/thinking preferences, up to six recent drafts, and up to 30 input-history items within a 512 KiB budget. Writes are atomic. Drafts and history contain user text; protect this file with session databases. Forest, light, and contrast themes retain explicit status labels.
