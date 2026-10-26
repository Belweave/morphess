# Terminal workspace

Open the terminal with `morphess` or `morphess tui --session <id>`. Node 26.4+ and an interactive terminal are required. The launcher enables Node's experimental FFI before loading OpenTUI; headless commands do not load it.

Morphess is independent, unofficial, and not developed, endorsed, sponsored, or backed by Morph.

## Navigation

The workspace contains a transcript, multiline composer, and status controls. The optional context/plan inspector appears at widths of at least 110 columns. Command, session, tool, and file selectors are keyboard-searchable. Use `morphess menu` to open the CLI command menu and `morphess --help` for command reference.

| Key | Action |
| --- | --- |
| Enter | Send input or answer the current question |
| Shift+Enter / Alt+Enter | Insert a newline, subject to terminal support |
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

## Plan and build mode

`/plan` restricts tools to reads, search, guarded Git inspection, guidance, human questions, working notes/plans, and restricted delegation. Stop active work before entering plan mode. Shell, file mutation, code mode, and deferred-tool loading are excluded.

`/build` restores the previous enabled tool names that still exist in selected extensions. It preserves model-facing tool filters. A delegated child inherits the parent's restricted tools and cannot enable missing tools. Workspace policy continues to apply in both modes; switching to build does not grant shell access.

Mode and restoration data are committed together with the native tool filter. Restrictions persist when the same session is reopened from another interface.

## Display and storage limits

The terminal projects the most recent 80 entries, up to 24,000 characters per message and 64,000 per tool detail. It removes terminal control sequences from displayed content while preserving original source in Pi's transcript. Export full history with `morphess export <session>` or use the paginated API.

Native event/document watches coalesce updates every 40 ms. Unchanged completed rows retain renderable identity. The UI does not run a separate execution loop.

Private `<stateDir>/ui.json` stores theme, inspector/thinking preferences, up to six recent drafts, and up to 30 input-history items within a 512 KiB budget. Writes are atomic. Drafts and history contain user text; protect this file with session databases. Forest, light, and contrast themes retain explicit status labels.
