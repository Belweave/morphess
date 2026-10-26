import { Help, type Command, type Option } from 'commander';
import { EventEmitter } from 'node:events';

const configured = new WeakSet<Command>();
const GROUPS = ['Setup:', 'Coding:', 'Sessions:', 'Integrations:'];
const COMMAND_GROUP: Record<string, string> = {
  init: 'Setup:', configure: 'Setup:', auth: 'Setup:', doctor: 'Setup:',
  tui: 'Coding:', menu: 'Coding:', run: 'Coding:', chat: 'Coding:',
  usage: 'Sessions:', sessions: 'Sessions:', resume: 'Sessions:', export: 'Sessions:', fork: 'Sessions:',
  tools: 'Integrations:', serve: 'Integrations:', mcp: 'Integrations:',
};

const EXAMPLES: Record<string, string> = {
  tui: `Examples:
  morphess
  morphess tui --session root
  morphess -C /path/to/project tui

Requires an interactive terminal and Node 26.4+. Ctrl+P opens commands,
Escape stops active work, and Ctrl+Q exits while preserving accepted work.`,
  menu: `Examples:
  morphess menu

Open the terminal command menu. Search for an action, select it with the
arrow keys, and press Enter. Escape closes the menu.`,
  configure: `Examples:
  morphess configure
  morphess configure --base-url https://api.morphllm.com/v1 --model morph-kimik3
  morphess configure --base-url https://provider.example/v1 --model model-id

Writes provider settings without credentials. Restart an active host after
endpoint or model changes. Use morphess auth login to enter a key.`,
  auth: `Examples:
  morphess auth login
  morphess auth status
  morphess auth logout

Keys are scoped to the configured endpoint and stored privately outside
the project. A configured environment credential takes precedence.`,
  'auth login': `Examples:
  morphess auth login
  morphess -C /path/to/project auth login

Enter the configured endpoint's API key in a masked terminal prompt.
The key is stored outside project files; it is never a command argument.`,
  'auth status': `Examples:
  morphess auth status

Reports credential availability and source without printing its key.`,
  'auth logout': `Examples:
  morphess auth logout

Removes the saved key for the exact configured endpoint. An environment
credential remains active until it is removed from the environment.`,
  init: `Examples:
  morphess init
  morphess -C /path/to/project init
  morphess -c agent.json init

Writes Morph defaults without overwriting an existing file. Enter a key
with morphess auth login; use morphess configure to change providers.`,
  doctor: `Examples:
  morphess doctor
  morphess -C /path/to/project -c morphess.json doctor

Checks configuration and credential presence without sending an inference
request. A ready configuration does not establish endpoint connectivity.`,
  run: `Examples:
  morphess run "Inspect the parser and report edge cases"
  cat task.txt | morphess run -
  morphess run "Implement the attached layout" --image ./layout.png
  morphess run "Fix the parser" --request-id parser-fix --json
  morphess run "Inspect the project" --session root --events
  morphess --trusted run "Run the project tests and fix failures"

--json returns the final result; --events emits durable JSONL events.
--request-id deduplicates admission within the selected conversation.
--trusted grants host shell authority. New questions are returned as text;
use the terminal or HTTP answer API for existing durable question waits.`,
  chat: `Examples:
  morphess chat
  morphess chat --session root

Line-oriented conversation. /new creates a session; /status shows context;
/compact requests compaction; /quit closes the host. For multiline editing,
menus, attachments, and durable question answers, use morphess tui.`,
  usage: `Examples:
  morphess usage
  morphess usage --session root --json

Reports provider token usage, cache reads/writes and configured model cost.
Missing cache metrics normalize to zero; no hit rate is inferred.`,
  sessions: `Examples:
  morphess sessions
  morphess -C /path/to/project sessions

Lists persisted conversation IDs and ownership records. Reopen a selected
conversation with morphess tui --session <id> or run --session <id>.`,
  resume: `Examples:
  morphess resume
  morphess -C /path/to/project resume

Resumes recoverable work and waits for idle. Pending human questions can
keep the command waiting; answer them through the terminal or HTTP API.`,
  export: `Examples:
  morphess export root
  morphess export 42 > transcript.jsonl

Exports committed conversation entries as JSONL. Output can contain user
prompts, source, attachments, and tool results; store it accordingly.`,
  fork: `Examples:
  morphess fork root 123
  morphess fork 42 456

Creates a conversation from a committed entry visible in the source
session and prints its ID. The original conversation remains available.`,
  tools: `Examples:
  morphess tools
  morphess tools --all
  morphess tools read --session root
  morphess tools codemode --json --schema
  morphess tools --session 42 --all --json

Inspect installed tool names, source extensions, replay policies, native
availability, and known host restrictions. --all includes deferred and
disabled tools; --schema includes argument schemas. This inspection does
not execute a tool or establish that arbitrary extension guards will pass.`,
  serve: `Examples:
  morphess serve
  morphess serve --host 127.0.0.1 --port 8787

Serves native sessions, durable SSE events, and the OpenAI-compatible chat
gateway. Set the environment variable named by server.tokenEnv before
binding outside loopback. The bearer token authorizes the entire host.`,
  mcp: `Examples:
  morphess mcp --help

Use the subcommand help for MCP connection and capability operations.
Configured server commands and endpoints retain their own authority.`,
};

/** Keep Commander's native grouping/formatting, with a stable operational group order. */
function groupItems<T extends Command | Option>(
  unsorted: T[], visible: T[], group: (item: T) => string,
): Map<string, T[]> {
  const items = new Help().groupItems(unsorted, visible, group);
  const rank = (heading: string) => { const index = GROUPS.indexOf(heading); return index < 0 ? GROUPS.length : index; };
  return new Map([...items].sort(([a], [b]) => rank(a) - rank(b)));
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current; current = current.parent) names.unshift(current.name());
  return names.join(' ');
}

/** Configure after commands are registered. Repeated calls also cover newly added children. */
export function configureCliHelp(program: Command): void {
  for (const command of program.commands) command.helpGroup(COMMAND_GROUP[command.name()] ?? 'Integrations:');
  program.commandsGroup('Integrations:');
  const visit = (command: Command): void => {
    if (!configured.has(command)) {
      configured.add(command);
      command.configureHelp({ ...command.configureHelp(), showGlobalOptions: true, groupItems });
      command.showSuggestionAfterError(true).showHelpAfterError(true);
      if (command === program) {
        command.addHelpText('after', `
Workflow:
  morphess init       Create configuration with Morph defaults
  morphess auth login Enter a provider key without shell-history exposure
  morphess doctor     Check configuration and credential presence
  morphess            Open the terminal workspace

Examples:
  cat task.txt | morphess run -
  morphess run "Implement this layout" --image ./layout.png
  morphess --trusted run "Run tests and fix failures"
  morphess tools --all --json

Terminal: Ctrl+P commands · Escape stop · Ctrl+Q quit and preserve work
Use morphess <command> --help for options and examples.
`);
      } else {
        const examples = (command.parent === program ? EXAMPLES[command.name()] : EXAMPLES[`${command.parent?.name()} ${command.name()}`])
          ?? `Examples:\n  ${commandPath(command)} --help\n\nUse the listed options and subcommands for this integration.`;
        if (!(command instanceof EventEmitter) || command.listenerCount('afterHelp') === 0) command.addHelpText('after', `\n${examples}\n`);
      }
    }
    for (const child of command.commands) visit(child);
  };
  visit(program);
}
