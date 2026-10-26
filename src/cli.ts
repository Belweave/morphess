#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { watchEvents, type Cursor, type Conversation } from '@earendil-works/pi-durable';
import { defaultConfig, loadConfig } from './config.js';
import { MorphessRuntime } from './runtime/runtime.js';
import { withImages } from './media/input.js';
import { serve } from './http/server.js';

export function createCli() {
  const program = new Command().name('morphess').description('A durable coding agent built on Pi Durable')
    .version('0.2.0').option('-c, --config <file>', 'configuration file').option('-C, --workspace <directory>', 'workspace directory').option('--trusted', 'allow unrestricted host shell execution')
    .addHelpText('after', '\nMorphess is an independent, unofficial harness for Morph inference.\nIt is not developed, endorsed, sponsored, or backed by Morph.\n');

  async function config() {
    const options = program.opts<{ config?: string; workspace?: string; trusted?: boolean }>();
    const loaded = await loadConfig({ cwd: options.workspace, path: options.config });
    if (options.trusted) loaded.policy.mode = 'trusted';
    return loaded;
  }

  async function usingRuntime<T>(run: (runtime: MorphessRuntime, target: (conversation: Conversation) => void) => Promise<T>, terminal = false, questions = true): Promise<T> {
    const runtime = await MorphessRuntime.open(await config(), { onReport: (_error, info) => {
      // Report categories only; provider diagnostics may contain credentials or private payloads.
      stderr.write(`[morphess] ${JSON.stringify(info)}\n`);
    }, nonInteractive: !questions });
    let target = runtime.root;
    const interrupt = () => { void target.abort(BACKGROUND_CONTEXT, { background: true }).catch(() => {}); };
    if (!terminal) process.on('SIGINT', interrupt);
    try { return await run(runtime, conversation => { target = conversation; }); }
    finally { process.off('SIGINT', interrupt); await runtime.close(); }
  }

  program.command('tui', { isDefault: true }).description('Open the focused coding workspace (Node 26.4+, native OpenTUI)')
    .option('-s, --session <id>', 'existing conversation', 'root').option('--demo', 'use a temporary workspace and offline scripted provider')
    .action(async (options: { session: string; demo?: boolean }) => {
      if (!stdin.isTTY || !stdout.isTTY) throw new Error('The TUI requires a terminal; use run - for piped input');
      const { bootstrapTerminal } = await import('./tui/bootstrap.js');
      if (await bootstrapTerminal()) return;
      const { launchTui } = await import('./tui/app.js');
      if (options.demo) {
        const { openDemoRuntime } = await import('./tui/demo.js');
        const demo = await openDemoRuntime();
        try { await launchTui(demo.runtime, { demo: true }); } finally { await demo.close(); }
      } else await usingRuntime(runtime => launchTui(runtime, { sessionId: options.session }), true);
    });

  program.command('init').description('Write a configuration template without overwriting existing configuration')
    .action(async () => {
      const options = program.opts<{ workspace?: string; config?: string }>();
      const cwd = resolve(options.workspace ?? process.cwd());
      const path = resolve(cwd, options.config ?? 'morphess.json');
      const template = defaultConfig(cwd);
      await writeFile(path, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      stdout.write(`Created ${path}\nSet your model endpoint/id and ${template.model.apiKeyEnv}, then run morphess doctor.\n`);
    });

  program.command('doctor').description('Validate configuration and report capabilities without calling a model')
    .action(async () => {
      const loaded = await config();
      const keyPresent = Boolean(process.env[loaded.model.apiKeyEnv]);
      stdout.write(`${JSON.stringify({
        node: process.version, workspace: loaded.workspace, stateDir: loaded.stateDir,
        provider: { baseUrl: loaded.model.baseUrl, id: loaded.model.id, api: loaded.model.api, contextWindow: loaded.model.contextWindow, maxOutputTokens: loaded.model.maxOutputTokens, input: loaded.model.input, authenticated: keyPresent, allowUnauthenticated: loaded.model.allowUnauthenticated },
        policy: loaded.policy.mode, codemode: loaded.codemode, plugins: loaded.plugins.length, mcpServers: loaded.mcp.length,
        ready: keyPresent || loaded.model.allowUnauthenticated,
      }, null, 2)}\n`);
      if (!keyPresent && !loaded.model.allowUnauthenticated) process.exitCode = 1;
    });

  program.command('run').description('Run a coding task; use - as prompt to read stdin').argument('[prompt...]')
    .option('-s, --session <id>', 'existing conversation; default root', 'root').option('--request-id <key>', 'durable idempotency key')
    .option('--image <file...>', 'attach local images').option('--json', 'print the final result as JSON').option('--events', 'stream durable agent events as JSONL')
    .action(async (words: string[], options: { session: string; requestId?: string; image?: string[]; json?: boolean; events?: boolean }) => {
      let prompt = words.join(' ');
      if (prompt === '-' || (!prompt && !stdin.isTTY)) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of stdin) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 24 * 1024 * 1024) throw new Error('Prompt exceeds 24 MiB');
          chunks.push(Buffer.from(chunk));
        }
        prompt = Buffer.concat(chunks).toString('utf8');
      }
      if (!prompt.trim()) throw new Error('Provide a task or pipe a prompt to morphess run -');
      await usingRuntime(async (runtime, setTarget) => {
        const conversation = await runtime.conversation(options.session);
        setTarget(conversation);
        const watch = options.events ? await watchEvents(runtime.harness, conversation.id, BACKGROUND_CONTEXT) : undefined;
        if (watch) {
          stdout.write(`${JSON.stringify(watch.snapshot)}\n`);
          watch.start(async (events) => { for (const event of events) stdout.write(`${JSON.stringify(event)}\n`); });
        }
        try {
          const content = await withImages(prompt, options.image ?? [], { stateDir: runtime.config.stateDir, supportsImages: runtime.config.model.input.includes('image') });
          const submission = await conversation.submit({ type: 'input', content, requestId: options.requestId }, BACKGROUND_CONTEXT);
          const answer = await runtime.answer(submission.id);
          await watch?.stop();
          if (options.json) stdout.write(`${JSON.stringify(answer)}\n`);
          else if (!options.events) stdout.write(`${answer.text}\n`);
          if (answer.submission.status !== 'done') {
            process.exitCode = 1;
            stderr.write(`Run ${answer.submission.id} ended: ${answer.submission.reason}\n`);
          }
        } finally { await watch?.stop(); }
      }, false, false);
    });

  program.command('chat').description('Interactive persistent terminal conversation').option('-s, --session <id>', 'conversation', 'root')
    .action(async (options: { session: string }) => usingRuntime(async (runtime, setTarget) => {
      if (!stdin.isTTY) throw new Error('Interactive chat requires a terminal; use run - for piped input');
      let conversation = await runtime.conversation(options.session);
      setTarget(conversation);
      const terminal = createInterface({ input: stdin, output: stdout });
      stdout.write(`Morphess · ${runtime.config.model.id} · ${runtime.config.policy.mode}\nSession ${conversation.id}. /new /status /compact /quit\n`);
      try {
        while (true) {
          let prompt: string;
          try { prompt = (await terminal.question('› ')).trim(); } catch { break; }
          if (!prompt) continue;
          if (prompt === '/quit' || prompt === '/exit') break;
          if (prompt === '/new') { conversation = await runtime.createConversation(); setTarget(conversation); stdout.write(`Session ${conversation.id}\n`); continue; }
          if (prompt === '/status') { stdout.write(`${JSON.stringify(await runtime.contextBudget(conversation.id), null, 2)}\n`); continue; }
          if (prompt === '/compact') { stdout.write(`Compaction task ${await conversation.compact(undefined, BACKGROUND_CONTEXT)}\n`); continue; }
          const submission = await conversation.submit({ type: 'input', content: prompt }, BACKGROUND_CONTEXT);
          const answer = await runtime.answer(submission.id);
          stdout.write(`${answer.text || JSON.stringify(answer.submission)}\n`);
        }
      } finally { terminal.close(); }
    }, false, false));

  program.command('serve').description('Serve sessions, durable events, and an OpenAI-compatible chat gateway')
    .option('--host <host>', 'bind address').option('--port <port>', 'bind port', Number)
    .action(async (options: { host?: string; port?: number }) => usingRuntime(async (runtime) => {
      const host = await serve(runtime, { ...options, onError: () => stderr.write('[morphess] HTTP request failed\n') });
      stdout.write(`Morphess listening at ${host.url}\n`);
      try {
        await new Promise<void>((resolve) => {
          const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); };
          process.once('SIGINT', done); process.once('SIGTERM', done);
        });
      } finally { await host.close(); }
    }, true));

  program.command('sessions').description('List persisted conversations').action(async () => usingRuntime(async (runtime) => {
    let cursor: Cursor | undefined;
    do {
      const page = await runtime.harness.commit((tx) => tx.scanConversations({}, 100, cursor), BACKGROUND_CONTEXT);
      for (const session of page.items) stdout.write(`${JSON.stringify(session)}\n`);
      cursor = page.next;
    } while (cursor);
  }));

  program.command('resume').description('Resume pending durable tasks and wait for idle').action(async () => usingRuntime(async (runtime) => {
    await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
    stdout.write(`${JSON.stringify(await runtime.harness.inspect(BACKGROUND_CONTEXT))}\n`);
  }));

  program.command('export').description('Export a conversation transcript as JSONL').argument('[session]', 'conversation', 'root')
    .action(async (id: string) => usingRuntime(async (runtime) => {
      const conversation = await runtime.conversation(id);
      let cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({ order: 'ascending' }, 100, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) stdout.write(`${JSON.stringify(entry)}\n`);
        cursor = page.next;
      } while (cursor);
    }));

  program.command('fork').description('Fork a conversation from a committed entry').argument('<session>').argument('<entry>')
    .action(async (session: string, entry: string) => usingRuntime(async (runtime) => { stdout.write(`${JSON.stringify({ id: (await runtime.fork(session, entry)).id })}\n`); }));

  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createCli().parseAsync().catch((error: unknown) => {
    stderr.write(`morphess: ${error instanceof Error ? error.message : 'Unknown failure'}\n`);
    process.exitCode = 1;
  });
}
