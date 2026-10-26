import {
  BoxRenderable, CliRenderEvents, createCliRenderer, InputRenderable, InputRenderableEvents, MarkdownRenderable,
  ScrollBoxRenderable, SelectRenderable, SelectRenderableEvents, SyntaxStyle, TextareaRenderable,
  TextAttributes, TextRenderable, destroyTreeSitterClient,
  type CliRenderer, type KeyEvent, type StyleDefinitionInput,
} from '@opentui/core';
import { basename } from 'node:path';
import type { MorphessRuntime } from '../runtime/runtime.js';
import { validateModelId, type ModelChoice } from '../models/catalog.js';
import { TuiController } from './controller.js';
import { previewDetail, sanitizeText, type TuiEntry, type TuiSnapshot } from './state.js';
import { MORPH_MARK, MORPH_MARK_SMALL, MORPH_GREEN } from './brand.js';
import { defaultPreferences, readPreferences, rememberDraft, writePreferences, type TuiPreferences } from './preferences.js';
import { fuzzyScore, isTheme, THEMES, tokens, type ThemeName, type TuiTheme } from './theme.js';

type Client = Pick<TuiController, 'state' | 'subscribe' | 'send' | 'abort' | 'newSession' | 'switchSession' | 'sessions' | 'fork' | 'compact' | 'setMode' | 'answer' | 'diff' | 'files' | 'tools' | 'provider' | 'models' | 'setModel'>;
interface MenuItem { name: string; description: string; run(): void | Promise<unknown>; }
interface Row { box: BoxRenderable; label: TextRenderable; body: TextRenderable | MarkdownRenderable; thinking: TextRenderable; revision: number; role: string; }
export interface TuiOptions { preferences?: TuiPreferences; stateDir?: string; launchMark?: boolean; onExit?(): void | Promise<void>; }
function syntaxStyles(p: TuiTheme): Record<string, StyleDefinitionInput> {
  return {
    default: { fg: p.text }, 'markup.heading': { fg: p.accent, bold: true }, 'markup.strong': { bold: true },
    'markup.italic': { italic: true }, 'markup.link': { fg: p.accent, underline: true }, 'markup.raw': { fg: p.accent },
    'punctuation.special': { fg: p.muted }, comment: { fg: p.muted }, keyword: { fg: p.accent }, string: { fg: p.warning },
    number: { fg: p.warning }, function: { fg: p.green }, type: { fg: p.accent },
  };
}

/** One native tree. Status/composer changes never recreate completed transcript nodes. */
export class MorphessTui {
  readonly root: BoxRenderable;
  readonly composer: TextareaRenderable;
  readonly transcript: ScrollBoxRenderable;
  readonly paletteInput: InputRenderable;
  readonly paletteList: SelectRenderable;
  #state: TuiSnapshot;
  #prefs: TuiPreferences;
  #theme: TuiTheme;
  #syntax: SyntaxStyle;
  #header: BoxRenderable;
  #brand: TextRenderable;
  #disclaimer: TextRenderable;
  #location: TextRenderable;
  #model: TextRenderable;
  #main: BoxRenderable;
  #conversation: BoxRenderable;
  #welcome: BoxRenderable;
  #logo: TextRenderable;
  #welcomeLabel: TextRenderable;
  #welcomeHint: TextRenderable;
  #sidebar: ScrollBoxRenderable;
  #inspector: TextRenderable;
  #question: BoxRenderable;
  #questionText: TextRenderable;
  #questionChoices: TextRenderable;
  #composerBox: BoxRenderable;
  #composerMeta: TextRenderable;
  #status: TextRenderable;
  #footer: TextRenderable;
  #palette: BoxRenderable;
  #paletteTitle: TextRenderable;
  #viewer: ScrollBoxRenderable;
  #viewerText: TextRenderable;
  #rows = new Map<string, Row>();
  #menu: MenuItem[] = [];
  #filtered: MenuItem[] = [];
  #overlay = false;
  #notice = '';
  #error = false;
  #images: string[] = [];
  #session: number;
  #off: () => void;
  #saveTimer?: NodeJS.Timeout;
  #saveQueue = Promise.resolve();
  #closed = false;
  #submitting = false;
  #historyIndex = -1;
  #historyDraft = '';
  #lastQuestion?: number;
  #launchMark = false;
  #launchTimer?: NodeJS.Timeout;
  #modelRequest?: AbortController;
  #queryAction?: (value: string) => void;
  #modeQueue = Promise.resolve();

  constructor(readonly renderer: CliRenderer, readonly client: Client, readonly options: TuiOptions = {}) {
    this.#state = client.state; this.#session = client.state.sessionId;
    this.#launchMark = Boolean(options.launchMark && client.state.entries.length);
    this.#prefs = options.preferences ?? defaultPreferences(); this.#theme = THEMES[this.#prefs.theme];
    const p = this.#theme;
    this.#syntax = SyntaxStyle.fromStyles(syntaxStyles(p), renderer.nativeScene);
    this.root = new BoxRenderable(renderer, { id: 'morphess', width: '100%', height: '100%', flexDirection: 'column', backgroundColor: p.background });
    this.#header = new BoxRenderable(renderer, { id: 'header', height: 4, flexShrink: 0, border: ['bottom'], borderColor: p.border, paddingX: 2, flexDirection: 'column' });
    const heading = new BoxRenderable(renderer, { height: 1, flexDirection: 'row' });
    this.#brand = this.text('morphess', p.accent, { attributes: TextAttributes.BOLD, width: 12 });
    this.#model = this.text('', p.muted, { flexGrow: 1, textAlign: 'right', truncate: true, height: 1 });
    heading.add(this.#brand); heading.add(this.#model); this.#header.add(heading);
    this.#disclaimer = this.text('Independent harness for Morph inference · not official or Morph-backed', p.muted, { id: 'independent-notice', height: 1, truncate: true }); this.#header.add(this.#disclaimer);
    this.#location = this.text('', p.muted, { height: 1, truncate: true }); this.#header.add(this.#location); this.root.add(this.#header);
    this.#main = new BoxRenderable(renderer, { flexGrow: 1, minHeight: 0, flexDirection: 'row' }); this.root.add(this.#main);
    this.#conversation = new BoxRenderable(renderer, { id: 'conversation', flexGrow: 1, minWidth: 0, flexDirection: 'column' }); this.#main.add(this.#conversation);
    this.#welcome = new BoxRenderable(renderer, { id: 'welcome', flexGrow: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', flexDirection: 'column', overflow: 'hidden' });
    this.#logo = this.text(MORPH_MARK, this.#prefs.theme === 'light' ? p.green : MORPH_GREEN, { id: 'morph-logo', width: 28, height: 12, flexShrink: 0, selectable: false });
    this.#welcome.add(this.#logo);
    this.#welcomeLabel = this.text('New session', p.text, { height: 1, attributes: TextAttributes.BOLD, marginTop: 1 }); this.#welcome.add(this.#welcomeLabel);
    this.#welcomeHint = this.text('Enter a task · /model choose model · Shift+Tab mode', p.muted, { height: 2, textAlign: 'center', maxWidth: 62, paddingX: 1 }); this.#welcome.add(this.#welcomeHint);
    this.#conversation.add(this.#welcome);
    this.transcript = new ScrollBoxRenderable(renderer, { id: 'transcript', flexGrow: 1, minHeight: 0, scrollY: true, scrollX: false, stickyScroll: true, stickyStart: 'bottom', viewportCulling: true, paddingX: 2, contentOptions: { flexDirection: 'column', paddingBottom: 1 }, scrollbarOptions: { showArrows: false } });
    this.#conversation.add(this.transcript);
    this.#sidebar = new ScrollBoxRenderable(renderer, { scrollY: true, scrollX: false, viewportCulling: true, id: 'inspector', width: 31, flexShrink: 0, border: ['left'], borderColor: p.border, paddingX: 2, paddingY: 1, backgroundColor: p.surface, flexDirection: 'column' });
    this.#inspector = this.text('', p.muted, { wrapMode: 'word' }); this.#sidebar.add(this.#inspector); this.#main.add(this.#sidebar);
    this.#question = new BoxRenderable(renderer, { id: 'question', border: ['top'], borderColor: p.accent, paddingX: 2, paddingY: 1, flexShrink: 0, flexDirection: 'column', visible: false, maxHeight: 8 });
    this.#questionText = this.text('', p.text, { attributes: TextAttributes.BOLD, wrapMode: 'word', maxHeight: 3 });
    this.#questionChoices = this.text('', p.accent, { wrapMode: 'word', maxHeight: 2 }); this.#question.add(this.#questionText); this.#question.add(this.#questionChoices); this.root.add(this.#question);
    this.#composerBox = new BoxRenderable(renderer, { id: 'composer-box', height: 6, flexShrink: 0, marginX: 1, border: true, borderColor: p.accent, backgroundColor: p.surface, flexDirection: 'column', paddingX: 1 });
    this.#composerMeta = this.text('', p.muted, { height: 1, truncate: true }); this.#composerBox.add(this.#composerMeta);
    this.composer = new TextareaRenderable(renderer, {
      id: 'composer', flexGrow: 1, minHeight: 1, wrapMode: 'word', textColor: p.text, backgroundColor: p.surface,
      focusedTextColor: p.text, focusedBackgroundColor: p.surface, cursorColor: p.accent,
      selectionBg: p.raised, selectionFg: p.text, placeholderColor: p.muted, placeholder: 'Enter a task or /command',
      keyBindings: [{ name: 'return', action: 'submit' }, { name: 'return', shift: true, action: 'newline' }, { name: 'return', meta: true, action: 'newline' }],
      onSubmit: () => { void this.submit(); },
    });
    this.#composerBox.add(this.composer); this.root.add(this.#composerBox);
    this.#status = this.text('', p.muted, { id: 'status', height: 1, paddingX: 2, truncate: true }); this.root.add(this.#status);
    this.#footer = this.text('', p.muted, { id: 'shortcuts', height: 1, paddingX: 2, truncate: true }); this.root.add(this.#footer);
    this.#palette = new BoxRenderable(renderer, { id: 'palette', position: 'absolute', zIndex: 100, border: true, borderColor: p.accent, backgroundColor: p.surface, paddingX: 1, flexDirection: 'column', visible: false });
    this.#paletteTitle = this.text('', p.text, { height: 1, attributes: TextAttributes.BOLD }); this.#palette.add(this.#paletteTitle);
    this.paletteInput = new InputRenderable(renderer, { id: 'palette-query', placeholder: 'Search commands…', textColor: p.text, backgroundColor: p.surface, focusedBackgroundColor: p.surface, cursorColor: p.accent, placeholderColor: p.muted });
    this.paletteInput.on(InputRenderableEvents.ENTER, () => this.choose());
    // Native content-change callbacks are deferred; INPUT runs before an Enter
    // received in the same terminal batch can select a stale command.
    this.paletteInput.on(InputRenderableEvents.INPUT, () => this.filterMenu()); this.#palette.add(this.paletteInput);
    this.paletteList = new SelectRenderable(renderer, { id: 'palette-results', flexGrow: 1, showDescription: true, wrapSelection: true, selectedBackgroundColor: p.raised, selectedTextColor: p.text, selectedDescriptionColor: p.muted, textColor: p.text, descriptionColor: p.muted, backgroundColor: p.surface });
    this.paletteList.on(SelectRenderableEvents.ITEM_SELECTED, () => this.choose()); this.#palette.add(this.paletteList);
    this.#viewer = new ScrollBoxRenderable(renderer, { id: 'detail-view', flexGrow: 1, minHeight: 0, scrollY: true, visible: false });
    this.#viewerText = this.text('', p.text, { wrapMode: 'word' }); this.#viewer.add(this.#viewerText); this.#palette.add(this.#viewer);
    this.root.add(this.#palette); renderer.root.add(this.root);
    this.composer.setText(this.#prefs.drafts[String(this.#session)] ?? '');
    this.composer.onContentChange = () => {
      if (this.composer.plainText.length > 64_000) { this.composer.setText(this.composer.plainText.slice(0, 64_000)); this.notify('Composer is limited to 64,000 characters; use file references for larger material.', true); }
      rememberDraft(this.#prefs, this.#session, this.composer.plainText); this.saveSoon();
    };
    renderer.keyInput.on('keypress', this.onKey); renderer.on(CliRenderEvents.RESIZE, this.resize);
    this.#off = client.subscribe((state) => this.update(state));
    this.resize(); this.update(this.#state); this.composer.focus();
    if (this.#launchMark) {
      this.#launchTimer = setTimeout(() => { this.#launchMark = false; this.update(this.#state); }, 600);
      this.#launchTimer.unref();
    }
  }

  private text(content: string, fg: string, options: ConstructorParameters<typeof TextRenderable>[1] = {}) {
    return new TextRenderable(this.renderer, { content: sanitizeText(content, 64_000), fg, wrapMode: 'word', selectionBg: this.#theme.raised, selectionFg: this.#theme.text, ...options });
  }

  private resize = () => {
    const short = this.renderer.height < 28; const narrow = this.renderer.width < 80;
    this.#header.height = this.renderer.height < 22 ? 3 : 4;
    this.#disclaimer.content = narrow ? 'Unofficial · independent · not Morph-backed' : 'Independent harness for Morph inference · not official or Morph-backed';
    this.#location.visible = this.renderer.height >= 22;
    this.#composerBox.height = this.renderer.height < 24 ? 4 : 6;
    this.#logo.content = short ? MORPH_MARK_SMALL : MORPH_MARK; this.#logo.width = short ? 14 : 28; this.#logo.height = short ? 6 : 12;
    this.#welcomeHint.visible = this.renderer.height >= 22;
    this.#sidebar.visible = this.#prefs.sidebar && this.renderer.width >= 110;
    const width = Math.min(96, Math.max(24, this.renderer.width - (narrow ? 2 : 12)));
    this.#palette.width = width; this.#palette.left = Math.max(0, Math.floor((this.renderer.width - width) / 2));
    this.#palette.height = Math.min(24, Math.max(8, this.renderer.height - 4)); this.#palette.top = Math.max(0, Math.floor((this.renderer.height - this.#palette.height) / 2));
    this.#footer.content = narrow ? 'Enter send · S-Tab mode · /model · C-p menu · C-q quit' : 'Enter send · Shift+Tab mode · /model choose model · Ctrl+P commands · Ctrl+Q quit';
    this.update(this.#state);
    this.renderer.requestRender();
  };

  update(state: TuiSnapshot) {
    if (this.#closed) return;
    if (state.sessionId !== this.#session) {
      rememberDraft(this.#prefs, this.#session, this.composer.plainText);
      this.#session = state.sessionId; this.#images = []; this.#notice = ''; this.#historyIndex = -1;
      this.composer.setText(this.#prefs.drafts[String(this.#session)] ?? '');
      for (const row of this.#rows.values()) row.box.destroyRecursively(); this.#rows.clear();
    }
    this.#state = state;
    this.#model.content = `${state.model}  ${state.mode === 'plan' ? 'PLAN' : 'CODE'}`;
    this.#location.content = `${state.workspace}  /  session ${state.sessionId}`;
    const hasEntries = state.entries.length > 0;
    this.#welcome.visible = !hasEntries || this.#launchMark; this.transcript.visible = hasEntries && !this.#launchMark;
    this.#welcomeLabel.content = this.#launchMark ? 'Opening session' : 'New session';
    const ids = new Set(state.entries.map(entry => entry.id));
    for (const [id, row] of this.#rows) if (!ids.has(id)) { row.box.destroyRecursively(); this.#rows.delete(id); }
    for (const entry of state.entries) this.updateRow(entry);
    const question = state.questions[0];
    this.#question.visible = Boolean(question);
    if (question) {
      this.#questionText.content = `Answer needed · ${question.question}`;
      this.#questionChoices.content = question.options.length ? question.options.map((choice, index) => `${index + 1} ${choice}`).join('   ') + '  · or type your answer' : 'Type your answer below and press Enter.';
      if (this.#lastQuestion !== question.id) { this.#lastQuestion = question.id; if (!this.#overlay) this.composer.focus(); }
    } else this.#lastQuestion = undefined;
    this.composer.placeholder = question ? 'Enter answer' : state.busy ? 'Enter steering instructions' : 'Enter a task or /command';
    const estimate = state.context?.estimatedInputTokens;
    this.#composerMeta.content = `${question ? 'ANSWER · Ctrl+R full question' : state.busy ? 'WORKING' : state.mode === 'plan' ? 'PLAN · read-only' : 'CODE · edit and tool access'}${this.#images.length ? `  ${this.#images.length} image(s) attached` : ''}  ·  ${state.policy}`;
    this.#composerBox.borderColor = question ? this.#theme.warning : this.#theme.accent;
    this.#status.fg = this.#error || state.error ? this.#theme.error : this.#theme.muted;
    const activity = question ? 'Awaiting answer' : state.busy ? `${state.status || 'Working'} · Esc stops` : state.status || 'Ready';
    const compact = this.renderer.width < 80;
    const contextLabel = estimate === undefined ? 'context pending' : compact
      ? `~${tokens(estimate)}/${tokens(state.context!.contextWindow)} ctx` : `~${tokens(estimate)} / ${tokens(state.context!.contextWindow)} context`;
    this.#status.content = this.#notice || state.error || `${activity}  ·  ${contextLabel}  ·  ${tokens(state.usage.output)} ${compact ? 'out' : 'output'}  ·  $${state.usage.cost.toFixed(4)}`;
    const plan = state.plan.slice(0, 8).map(step => `${step.status === 'completed' ? '[x]' : step.status === 'in_progress' ? '[>]' : '[ ]'} ${step.step}`).join('\n');
    this.#inspector.content = `SESSION ${state.sessionId}\n${basename(state.workspace)}\n\nMODEL\n${state.model}\n\nCONTEXT\n${estimate === undefined ? 'Measured after a request' : `${tokens(estimate)} / ${tokens(state.context!.contextWindow)} tokens`}\n\nUSAGE\n${tokens(state.usage.input)} uncached input\n${tokens(state.usage.output)} output\n${tokens(state.usage.cacheRead)} cache read\n${tokens(state.usage.cacheWrite ?? 0)} cache write\n$${state.usage.cost.toFixed(4)} reported\n\n${plan ? `PLAN\n${plan}` : 'PLAN\nNo plan yet'}\n\nCtrl+B hides inspector`;
  }

  private updateRow(entry: TuiEntry) {
    let row = this.#rows.get(entry.id);
    if (!row) {
      const box = new BoxRenderable(this.renderer, { id: `turn-${entry.id}`, flexDirection: 'column', flexShrink: 0, marginTop: 1 });
      const label = this.text('', this.#theme.muted, { height: 1, truncate: true, attributes: TextAttributes.BOLD }); box.add(label);
      const thinking = this.text('', this.#theme.muted, { maxHeight: 10, visible: false, wrapMode: 'word' }); box.add(thinking);
      const body = entry.role === 'assistant'
        ? new MarkdownRenderable(this.renderer, { id: `body-${entry.id}`, content: '', syntaxStyle: this.#syntax, fg: this.#theme.text, streaming: entry.status === 'running', conceal: true, tableOptions: { style: 'columns', borders: false } })
        : this.text('', this.#theme.text, { wrapMode: 'word', maxHeight: entry.role === 'tool' ? 2 : undefined });
      box.add(body); this.transcript.add(box);
      row = { box, label, thinking, body, role: entry.role, revision: -1 }; this.#rows.set(entry.id, row);
    }
    if (row.revision === entry.revision && row.thinking.visible === (this.#prefs.thinking && Boolean(entry.thinking))) return;
    row.revision = entry.revision;
    const tool = entry.role === 'tool';
    row.label.content = tool ? `${entry.status === 'running' ? '[~]' : entry.status === 'error' ? '[!]' : '[+]'} ${entry.toolName ?? 'tool'}  ${entry.status === 'running' ? 'running' : entry.status === 'error' ? 'failed · Ctrl+T inspect' : 'done · Ctrl+T inspect'}` : `${entry.role === 'user' ? 'You' : entry.role === 'notice' ? 'Morphess' : 'Morphess'}${entry.status === 'running' ? ' · streaming' : entry.status === 'error' ? ' · interrupted' : ''}`;
    row.label.fg = entry.status === 'error' ? this.#theme.error : entry.role === 'user' ? this.#theme.accent : this.#theme.muted;
    row.thinking.visible = this.#prefs.thinking && Boolean(entry.thinking); row.thinking.content = entry.thinking ? `Thinking\n${entry.thinking.slice(-4_000)}` : '';
    row.body.content = tool ? entry.text.replace(/\n+/g, ' ').slice(0, 240) : entry.text;
    if (row.body instanceof MarkdownRenderable) row.body.streaming = entry.status === 'running';
  }

  private notify(message: string, error = false) { this.#notice = sanitizeText(message, 2_000); this.#error = error; this.update(this.#state); }
  private run(action: () => void | Promise<unknown>) { void Promise.resolve().then(action).catch(error => this.notify(error instanceof Error ? error.message : 'Action failed', true)); }

  async submit(): Promise<void> {
    if (this.#closed || this.#overlay || this.#submitting) return;
    const original = this.composer.plainText;
    const session = this.#session;
    const text = original.trim();
    if (!text) return;
    this.#submitting = true;
    this.#notice = ''; this.#error = false;
    try {
      if (text.startsWith('/')) {
        this.composer.clear();
        try { await this.command(text); }
        catch (error) { if (session === this.#session && !this.composer.plainText) this.composer.setText(original); throw error; }
        return;
      }
      const question = this.#state.questions[0];
      if (question) {
        const choice = /^\d+$/.test(text) ? question.options[Number(text) - 1] : undefined;
        await this.client.answer(question.id, choice ?? text);
      } else {
        await this.client.send(text, this.#images);
        this.#prefs.history = [...this.#prefs.history.filter(previous => previous !== text), text.slice(0, 8_000)].slice(-30);
      }
      if (session === this.#session) {
        this.#images = []; this.#historyIndex = -1;
        if (this.composer.plainText === original) this.composer.clear();
      }
      this.saveSoon(); this.update(this.#state);
    } catch (error) { this.notify(error instanceof Error ? error.message : 'Unable to send', true); }
    finally { this.#submitting = false; }
  }

  private async command(text: string) {
    const [name, ...words] = text.split(/\s+/); const argument = words.join(' ');
    switch (name) {
      case '/new': await this.client.newSession(); break;
      case '/sessions': await this.showSessions(); break;
      case '/fork': await this.client.fork(argument ? Number(argument) : undefined); break;
      case '/compact': await this.client.compact(); this.notify('Context compaction requested.'); break;
      case '/plan': await this.client.setMode('plan'); break;
      case '/code':
      case '/build': await this.client.setMode('build'); break;
      case '/mode': this.showModes(); break;
      case '/models':
      case '/model': if (argument) this.reviewModel({ id: validateModelId(argument), name: argument, source: 'manual' }); else await this.showModels(); break;
      case '/codemode': this.showCodeTools(); break;
      case '/abort': await this.client.abort(); break;
      case '/diff': await this.showDiff(); break;
      case '/tools': this.showTools(); break;
      case '/catalog': await this.showAgentTools(); break;
      case '/provider': await this.showProvider(); break;
      case '/files': await this.showFiles(argument); break;
      case '/attach': {
        if (!argument) throw new Error('Use /attach /path/to/image.png');
        if (this.#images.length >= 16) throw new Error('At most 16 images per input');
        this.#images.push(argument.replace(/^(['"])(.*)\1$/, '$2')); this.notify(`Image attached: ${basename(argument)}`); break;
      }
      case '/theme': if (isTheme(argument)) this.setTheme(argument); else this.showThemes(); break;
      case '/thinking': this.#prefs.thinking = !this.#prefs.thinking; this.invalidateRows(); this.saveSoon(); break;
      case '/answer': {
        const question = this.#state.questions[0]; if (!question) throw new Error('There is no pending question');
        await this.client.answer(question.id, argument); break;
      }
      case '/help': this.showHelp(); break;
      case '/quit': case '/exit': await this.options.onExit?.(); break;
      default: throw new Error(`Unknown command ${name}. Press Ctrl+P or use /help.`);
    }
  }

  private commands(): MenuItem[] {
    return [
      { name: 'Choose model', description: `Current: ${this.#state.model} · /model · provider /models catalog`, run: () => this.showModels() },
      { name: 'Change mode', description: `Current: ${this.#state.mode === 'plan' ? 'Plan' : 'Code'} · Shift+Tab · edits or read-only planning`, run: () => this.showModes() },
      { name: 'New session', description: 'Start a fresh durable conversation · Ctrl+N', run: () => this.client.newSession() },
      { name: 'Switch session', description: 'Search existing conversations · Ctrl+O', run: () => this.showSessions() },
      { name: 'Code tools', description: `JavaScript sandbox for tool calls · ${this.#state.codemode === false ? 'disabled in configuration' : this.#state.mode === 'plan' ? 'available in Code mode' : 'enabled'} · /codemode`, run: () => this.showCodeTools() },
      { name: 'Inspect tool activity', description: 'Read full retained tool arguments and output · Ctrl+T', run: () => this.showTools() },
      { name: 'Inspect agent tools', description: 'Tools, code mode, MCP, schemas and policy', run: () => this.showAgentTools() },
      { name: 'Provider settings', description: 'Endpoint, model, credential source and configuration commands', run: () => this.showProvider() },
      { name: 'Review workspace diff', description: 'Read the current Git diff', run: () => this.showDiff() },
      { name: 'Find a file', description: 'Search workspace paths and add a reference to your prompt', run: () => this.showFiles('') },
      { name: 'Fork conversation', description: 'Branch from the last committed assistant entry', run: () => this.client.fork() },
      { name: 'Compact context', description: 'Keep a summary and recent work through Pi Durable', run: () => this.client.compact() },
      { name: 'Toggle inspector', description: 'Context, usage and plan · Ctrl+B', run: () => this.toggleSidebar() },
      { name: 'Change theme', description: 'Forest, light, or high contrast', run: () => this.showThemes() },
      { name: 'Toggle thinking', description: 'Show or collapse retained model reasoning', run: () => { this.#prefs.thinking = !this.#prefs.thinking; this.invalidateRows(); this.saveSoon(); } },
      { name: 'Copy last answer', description: 'Send selected text or the last answer to terminal clipboard · Ctrl+Y', run: () => this.copyAnswer() },
      { name: 'Stop current work', description: 'Abort the current ownership subtree · Escape', run: () => this.client.abort() },
      ...(this.#state.questions.length ? [{ name: 'Read pending question', description: 'Full question and all suggested answers · Ctrl+R', run: () => this.showQuestion() }] : []),
      { name: 'Keyboard shortcuts', description: 'Commands, multiline editing and navigation', run: () => this.showHelp() },
      { name: 'Quit', description: 'Close the terminal; unfinished work remains recoverable · Ctrl+Q', run: () => this.options.onExit?.() },
    ];
  }

  showCommands() { this.showMenu('Commands', this.commands()); }
  private showModes() {
    this.showMenu('Choose mode · Shift+Tab cycles', [
      { name: `${this.#state.mode === 'build' ? '* ' : ''}Code`, description: 'Edit files and use enabled tools · /code', run: () => this.client.setMode('build') },
      { name: `${this.#state.mode === 'plan' ? '* ' : ''}Plan`, description: 'Read, inspect, and plan with read-only tools · /plan', run: () => this.client.setMode('plan') },
    ]);
  }
  private cycleMode(): Promise<void> {
    this.#modeQueue = this.#modeQueue.catch(() => {}).then(() => this.client.setMode(this.client.state.mode === 'plan' ? 'build' : 'plan'));
    return this.#modeQueue;
  }
  private showCodeTools() {
    this.showText('Code tools', `The codemode tool runs JavaScript in a sandbox and calls enabled harness tools through tools.*.\n\n${this.#state.codemode === false ? 'Disabled: set codemode to true in morphess.json and restart.' : this.#state.mode === 'plan' ? 'Installed. Switch to Code with Shift+Tab or /code to enable it.' : 'Enabled. The agent chooses this tool when useful; no extra workflow mode is required.'}\n\nTool permissions and durable execution still apply. Inspect its parameters with /catalog or morphess tools codemode --json.\n\nCode is the editing workflow; Plan restricts tools to read-only work. /build remains an alias for /code.`);
  }
  private async showModels(refresh = false): Promise<void> {
    this.#modelRequest?.abort();
    const request = new AbortController();
    this.showText('Models', 'Loading the configured provider’s /models catalog…');
    this.#modelRequest = request;
    const session = this.#session;
    try {
      const models = await this.client.models(refresh, request.signal);
      if (request.signal.aborted || this.#closed || this.#session !== session) return;
      this.#modelRequest = undefined;
      this.showMenu('Choose model', [
        ...models.map(model => ({ name: `${model.id === this.#state.model ? '* ' : ''}${model.id}`, description: `${model.name !== model.id ? `${model.name} · ` : ''}${model.contextWindow ? `${tokens(model.contextWindow)} context` : 'Limits not reported'} · ${model.input?.join('/') ?? 'modalities not reported'}${model.source === 'configured' ? ' · configured profile' : ''}`, run: () => this.reviewModel(model) })),
        { name: 'Enter a model ID', description: 'For a private model or a provider without /models', run: () => this.manualModel() },
        { name: 'Refresh model list', description: 'Fetch a fresh catalog from this provider', run: () => this.showModels(true) },
      ]);
    } catch (error) {
      if (request.signal.aborted || this.#closed || this.#session !== session) return;
      this.#modelRequest = undefined;
      this.showMenu('Model list unavailable', [
        { name: 'Retry model discovery', description: error instanceof Error ? error.message : 'Check the endpoint and key', run: () => this.showModels(true) },
        { name: 'Enter a model ID', description: 'Review and use the configured limits and modalities', run: () => this.manualModel() },
        { name: 'Provider settings', description: 'Inspect the endpoint and credential source', run: () => this.showProvider() },
      ]);
    }
  }
  private manualModel() {
    this.showMenu('Enter model ID', []);
    this.#queryAction = id => this.reviewModel({ id: validateModelId(id), name: id, source: 'manual' });
    this.paletteInput.placeholder = 'Model ID, for example morph-kimik3'; this.filterMenu();
  }
  private reviewModel(model: ModelChoice) {
    this.showMenu(`Load ${model.id}`, [
      { name: 'Use in this session', description: `${model.contextWindow ? `${tokens(model.contextWindow)} context` : 'Configured context limit'} · ${model.input?.join('/') ?? 'configured modalities'} · configured output ceiling. ${model.source === 'manual' || !model.contextWindow || !model.input ? 'Unreported capabilities inherit your configuration.' : 'Provider-reported capabilities.'}`, run: async () => { await this.client.setModel(model); this.notify(`Model: ${model.id} · saved for this session`); } },
      { name: 'Back to model list', description: 'Choose another model or refresh the provider catalog', run: () => this.showModels() },
    ]);
  }
  private showMenu(title: string, items: MenuItem[]) {
    if (this.#closed) return;
    this.#modelRequest?.abort(); this.#modelRequest = undefined; this.#queryAction = undefined;
    this.#overlay = true; this.#palette.visible = true; this.#paletteTitle.content = `${title}  ·  Esc closes`;
    this.#menu = items.map(item => ({ ...item, name: sanitizeText(item.name, 512), description: sanitizeText(item.description, 1_000) })); this.#viewer.visible = false; this.paletteList.visible = true; this.paletteInput.visible = true;
    this.paletteInput.placeholder = `Search ${title.toLowerCase()}…`; this.paletteInput.value = ''; this.filterMenu(); this.paletteInput.focus();
  }
  private filterMenu() {
    if (this.#queryAction) { this.paletteList.options = [{ name: this.paletteInput.value ? `Use ${this.paletteInput.value}` : 'Enter a model ID above', description: 'Enter reviews the profile; Escape cancels', value: 0 }]; return; }
    this.#filtered = this.#menu.map((item, index) => ({ item, index, score: fuzzyScore(this.paletteInput.value, `${item.name} ${item.description}`) })).filter(match => match.score >= 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 100).map(match => match.item);
    this.paletteList.options = this.#filtered.length ? this.#filtered.map((item, index) => ({ name: item.name, description: item.description, value: index })) : [{ name: 'No matches', description: 'Try another search', value: -1 }];
    this.paletteList.setSelectedIndex(0);
  }
  private choose() {
    if (!this.#overlay || !this.paletteList.visible) return;
    if (this.#queryAction) { const action = this.#queryAction; const value = this.paletteInput.value.trim(); this.run(() => action(value)); return; }
    const item = this.#filtered[this.paletteList.getSelectedIndex()]; if (!item) return;
    this.closeOverlay(); this.run(() => item.run());
  }
  private closeOverlay() { this.#modelRequest?.abort(); this.#modelRequest = undefined; this.#queryAction = undefined; this.#overlay = false; this.#palette.visible = false; this.composer.focus(); }
  private showText(title: string, text: string) {
    if (this.#closed) return;
    this.#modelRequest?.abort(); this.#modelRequest = undefined; this.#queryAction = undefined;
    this.#overlay = true; this.#palette.visible = true; this.#paletteTitle.content = `${title}  ·  PgUp/PgDn scroll · Esc closes`;
    this.paletteInput.visible = false; this.paletteList.visible = false; this.#viewer.visible = true; this.#viewerText.content = sanitizeText(text, 64_000) || 'Nothing to show.'; this.#viewer.scrollTo(0); this.composer.blur();
  }
  private async showSessions() {
    const sessions = await this.client.sessions();
    this.showMenu('Sessions', sessions.map(session => ({ name: `${session.id === this.#state.sessionId ? '* ' : ''}${session.label}`, description: `Session ${session.id}`, run: () => this.client.switchSession(session.id) })));
  }
  private showTools() {
    const tools = this.#state.entries.filter(entry => entry.role === 'tool').slice().reverse();
    if (!tools.length) { this.showText('Tool activity', 'No tools have run in the visible conversation yet.'); return; }
    this.showMenu('Tool activity', tools.map(entry => ({ name: `${entry.toolName ?? 'tool'} · ${entry.status}`, description: entry.text.replace(/\n/g, ' ').slice(0, 90), run: () => this.showText(entry.toolName ?? 'Tool', entry.detail || entry.text) })));
  }
  private async showDiff() { this.showText('Workspace diff', await this.client.diff()); }
  private async showProvider() {
    const provider = await this.client.provider();
    this.showText('Provider settings', `Endpoint: ${provider.baseUrl}\nModel: ${provider.model}\nAPI: ${provider.api}\nCredential: ${provider.source}\nEnvironment variable: ${provider.apiKeyEnv}\n\nChange endpoint/model:\n  morphess configure --base-url <url> --model <id>\n\nEnter or rotate a key:\n  morphess auth login\n\nInspect credential status:\n  morphess auth status\n\nRestart the host after endpoint/model changes. Stored key updates apply to subsequent requests.`);
  }
  private async showAgentTools() {
    const catalog = await this.client.tools();
    this.showMenu(`Agent tools · session ${catalog.sessionId}`, catalog.tools.map(tool => ({
      name: `${tool.name} · ${tool.status}`, description: tool.description,
      run: async () => {
        const detail = (await this.client.tools(tool.name)).tools[0];
        if (detail) this.showText(tool.name, `${detail.description}\n\nStatus: ${detail.status}\nSource: ${detail.source}\nReplay: ${detail.replay}\n${detail.reason ?? ''}\n\n${previewDetail(detail.parameters)}`);
      },
    })));
  }
  private async showFiles(query: string) {
    const paths = await this.client.files(query);
    this.showMenu('Files', paths.map(path => ({ name: path, description: 'Insert a workspace-relative file reference', run: () => { this.composer.insertText(`${this.composer.plainText ? ' ' : ''}@${path}`); } })));
  }
  private showThemes() { this.showMenu('Themes', (Object.keys(THEMES) as ThemeName[]).map(name => ({ name: `${name === this.#prefs.theme ? '* ' : ''}${name}`, description: name === 'forest' ? 'Dark green background' : name === 'light' ? 'Light background' : 'High contrast', run: () => this.setTheme(name) }))); }
  private showQuestion() {
    const question = this.#state.questions[0];
    if (!question) { this.notify('There is no pending question.'); return; }
    this.showText(`Question · session ${question.conversationId}`, `${question.question}\n\n${question.options.map((option, index) => `${index + 1}. ${option}`).join('\n\n')}\n\nEscape returns to the composer. Type a number or a freeform answer.`);
  }
  private showHelp() { this.showText('Keyboard and commands', `Morphess is an independent, unofficial harness for Morph inference.\nIt is not developed, endorsed, sponsored, or backed by Morph.\n\nEnter          Send prompt or answer pending question\nShift+Enter    Add a new line\nShift+Tab      Cycle Code / Plan\nCtrl+P         Search commands\nCtrl+N         New session\nCtrl+O         Switch session\nCtrl+B         Toggle inspector (wide terminals)\nCtrl+T         Inspect tools\nCtrl+Y         Copy selection or last answer\nCtrl+R         Read full pending question and choices\nCtrl+U         Clear composer\nUp / Down      Recall prompt history when composer is empty\nPageUp/Down    Scroll transcript or detail view\nEscape         Close a menu; otherwise stop current work\nCtrl+C         Stop work, or quit when idle\nCtrl+Q         Quit and preserve unfinished work\n\n/new  /sessions  /fork [entry]  /compact\n/mode  /code  /plan  /build (alias)  /model [id]  /codemode  /abort  /diff  /tools  /catalog  /provider  /files [query]\n/attach /path/to/image.png  /theme [forest|light|contrast]\n/thinking  /answer text  /help  /quit\n\nCode mode enables edits and tools. Plan mode uses read-only tools. Shift+Tab cycles them.\n/model opens the authenticated provider catalog; selected profiles persist per session.\nThe codemode JavaScript tool is available in Code mode when enabled in configuration.\nHost shell access still requires explicit --trusted or trusted configuration.\nAccepted work is durable. Closing the UI preserves unfinished tasks.\nType a number to select a suggested answer, or give a freeform reply.`); }
  private toggleSidebar() { this.#prefs.sidebar = !this.#prefs.sidebar; this.resize(); this.saveSoon(); if (this.renderer.width < 110 && this.#prefs.sidebar) this.notify('Inspector appears at 110 columns or wider.'); }
  private copyAnswer() {
    const text = this.renderer.getSelection()?.getSelectedText() || this.#state.entries.filter(entry => entry.role === 'assistant').at(-1)?.text;
    if (!text) { this.notify('No answer or selection to copy.'); return; }
    this.notify(this.renderer.copyToClipboardOSC52(text) ? 'Copy request sent to your terminal clipboard.' : 'Terminal clipboard is unavailable.', false);
  }
  private setTheme(name: ThemeName) {
    this.#prefs.theme = name; this.#theme = THEMES[name]; const p = this.#theme;
    this.root.backgroundColor = p.background; this.renderer.setBackgroundColor(p.background);
    this.#header.borderColor = p.border; this.#brand.fg = p.accent; this.#model.fg = p.muted; this.#location.fg = p.muted; this.#disclaimer.fg = p.muted;
    this.#logo.fg = name === 'light' ? p.green : MORPH_GREEN;
    this.#sidebar.backgroundColor = p.surface; this.#sidebar.borderColor = p.border; this.#inspector.fg = p.muted;
    this.#composerBox.backgroundColor = p.surface; this.#composerBox.borderColor = p.accent;
    this.composer.backgroundColor = p.surface; this.composer.focusedBackgroundColor = p.surface; this.composer.textColor = p.text; this.composer.focusedTextColor = p.text; this.composer.cursorColor = p.accent; this.composer.placeholderColor = p.muted;
    this.#composerMeta.fg = p.muted; this.#footer.fg = p.muted; this.#welcomeLabel.fg = p.text; this.#welcomeHint.fg = p.muted;
    this.#palette.backgroundColor = p.surface; this.#palette.borderColor = p.accent; this.#paletteTitle.fg = p.text;
    this.paletteInput.backgroundColor = p.surface; this.paletteInput.focusedBackgroundColor = p.surface; this.paletteInput.textColor = p.text; this.paletteInput.focusedTextColor = p.text; this.paletteInput.placeholderColor = p.muted;
    this.paletteList.backgroundColor = p.surface; this.paletteList.textColor = p.text; this.paletteList.descriptionColor = p.muted; this.paletteList.selectedBackgroundColor = p.raised; this.paletteList.selectedTextColor = p.text; this.paletteList.selectedDescriptionColor = p.muted;
    this.#viewerText.fg = p.text; this.#questionText.fg = p.text; this.#questionChoices.fg = p.accent;
    for (const [name, style] of Object.entries(syntaxStyles(p))) this.#syntax.registerStyle(name, style);
    for (const row of this.#rows.values()) if (row.body instanceof MarkdownRenderable) row.body.refreshStyles();
    this.invalidateRows(); this.saveSoon();
  }
  private invalidateRows() { for (const row of this.#rows.values()) { row.revision = -1; row.thinking.fg = this.#theme.muted; if (row.body instanceof MarkdownRenderable) row.body.fg = this.#theme.text; else row.body.fg = this.#theme.text; } this.update(this.#state); }

  private onKey = (key: KeyEvent) => {
    const consume = () => { key.preventDefault(); key.stopPropagation(); };
    if (key.eventType === 'release') return;
    if (this.#launchMark) { clearTimeout(this.#launchTimer); this.#launchMark = false; this.update(this.#state); }
    if (key.name === 'tab' && key.shift) { consume(); if (this.#overlay) this.closeOverlay(); this.run(() => this.cycleMode()); return; }
    if (this.#overlay) {
      if (key.name === 'escape' || (key.ctrl && key.name === 'p')) { consume(); this.closeOverlay(); return; }
      if (key.ctrl && key.name === 'q') { consume(); this.run(() => this.options.onExit?.()); return; }
      if (this.#viewer.visible) {
        if (['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name)) {
          consume(); if (key.name === 'home') this.#viewer.scrollTo(0); else if (key.name === 'end') this.#viewer.scrollTo(this.#viewer.scrollHeight); else this.#viewer.scrollBy((['up', 'pageup'].includes(key.name) ? -1 : 1) * (key.name.includes('page') ? 12 : 1));
        }
        return;
      }
      if (key.name === 'up' || key.name === 'down') { consume(); key.name === 'up' ? this.paletteList.moveUp() : this.paletteList.moveDown(); return; }
      return;
    }
    if (key.ctrl) {
      const action: Record<string, () => void | Promise<unknown>> = {
        p: () => this.showCommands(), o: () => this.showSessions(), n: () => this.client.newSession(),
        b: () => this.toggleSidebar(), t: () => this.showTools(), y: () => this.copyAnswer(),
        r: () => this.showQuestion(),
        q: () => this.options.onExit?.(), u: () => this.composer.clear(),
        c: () => this.#state.busy ? this.client.abort() : this.options.onExit?.(),
      };
      if (action[key.name]) { consume(); this.run(() => action[key.name]!()); return; }
    }
    if (key.name === 'escape' && this.#state.busy) { consume(); this.run(() => this.client.abort()); return; }
    if (key.name === 'pageup' || key.name === 'pagedown') { consume(); this.transcript.scrollBy(key.name === 'pageup' ? -12 : 12); return; }
    if (key.name === 'tab' && this.composer.plainText.startsWith('/')) { consume(); this.showCommands(); this.paletteInput.value = this.composer.plainText.slice(1); return; }
    if ((key.name === 'up' || key.name === 'down') && (this.#historyIndex >= 0 || !this.composer.plainText)) {
      consume(); const history = this.#prefs.history;
      if (!history.length) return;
      if (this.#historyIndex < 0) this.#historyDraft = this.composer.plainText;
      this.#historyIndex = key.name === 'up' ? Math.min(history.length - 1, this.#historyIndex + 1) : Math.max(-1, this.#historyIndex - 1);
      this.composer.setText(this.#historyIndex < 0 ? this.#historyDraft : history[history.length - 1 - this.#historyIndex]!);
    }
  };

  private saveSoon() {
    clearTimeout(this.#saveTimer);
    if (!this.options.stateDir || this.#closed) return;
    this.#saveTimer = setTimeout(() => this.save(), 500); this.#saveTimer.unref();
  }
  private save() {
    if (!this.options.stateDir) return;
    const value = structuredClone(this.#prefs);
    this.#saveQueue = this.#saveQueue.then(() => writePreferences(this.options.stateDir!, value)).catch(() => { if (!this.#closed) this.notify('Could not save terminal preferences.', true); });
  }
  async close() {
    this.#modelRequest?.abort();
    if (this.#closed) return; this.#closed = true; clearTimeout(this.#saveTimer); clearTimeout(this.#launchTimer);
    rememberDraft(this.#prefs, this.#session, this.composer.plainText); this.save();
    this.#off(); this.renderer.keyInput.off('keypress', this.onKey); this.renderer.off(CliRenderEvents.RESIZE, this.resize);
    await this.#saveQueue; this.root.destroyRecursively(); this.#syntax.destroy(); this.#rows.clear();
  }
}

export async function launchTui(runtime: MorphessRuntime, options: { sessionId?: string | number; menu?: boolean } = {}) {
  const controller = await TuiController.open(runtime, { sessionId: options.sessionId });
  let renderer: CliRenderer | undefined; let app: MorphessTui | undefined;
  let end!: () => void; const done = new Promise<void>(resolve => { end = resolve; });
  const terminate = () => end();
  try {
    const preferences = await readPreferences(runtime.config.stateDir);
    renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], screenMode: 'alternate-screen', backgroundColor: THEMES[preferences.theme].background, targetFps: 24, maxFps: 30, useMouse: true, enableMouseMovement: false, consoleMode: 'disabled', openConsoleOnError: false });
    app = new MorphessTui(renderer, controller, { preferences, stateDir: runtime.config.stateDir, launchMark: true, onExit: end });
    if (options.menu) app.showCommands();
    process.once('SIGTERM', terminate); process.once('SIGHUP', terminate);
    await Promise.race([done, renderer.closed]);
  } finally {
    process.off('SIGTERM', terminate); process.off('SIGHUP', terminate);
    try { await app?.close(); }
    finally {
      renderer?.destroy();
      try { await renderer?.closed; }
      finally { try { await controller.close(); } finally { await destroyTreeSitterClient(); } }
    }
  }
}
