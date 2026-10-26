import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestRendererSetup } from '@opentui/core/testing';
import type { MorphessTui as TuiClass, TuiOptions } from '../src/tui/app.js';
import type { TuiSnapshot } from '../src/tui/state.js';
import { defaultPreferences } from '../src/tui/preferences.js';
import { THEMES } from '../src/tui/theme.js';
import type { ModelChoice } from '../src/models/catalog.js';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
let ffiEnabled = false;
try { ffiEnabled = Boolean(process.getBuiltinModule?.('node:ffi')); } catch { /* Native FFI is optional for headless test runs. */ }
const supported = (major > 26 || major === 26 && minor >= 4) && ffiEnabled;
type Client = ConstructorParameters<typeof TuiClass>[1];
let native: typeof import('@opentui/core');
let testing: typeof import('@opentui/core/testing');
let MorphessTui: typeof TuiClass;
const active: Array<{ app: TuiClass; setup: TestRendererSetup }> = [];

function initialState(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    sessionId: 17, workspace: '/work/morphess', model: 'local/special-1m', policy: 'workspace-write', mode: 'build', codemode: true,
    busy: false, entries: [], questions: [], plan: [], usage: { input: 1200, output: 42, cacheRead: 100, cost: 0.0123 }, status: 'Ready', version: 1,
    ...overrides,
  };
}
function mockClient(initial = initialState()) {
  let state = initial;
  const listeners = new Set<(state: TuiSnapshot) => void>();
  const emit = (patch: Partial<TuiSnapshot>) => {
    state = { ...state, ...patch, version: state.version + 1 };
    for (const listener of listeners) listener(state);
  };
  const client = {
    get state() { return state; },
    subscribe: vi.fn((listener: (state: TuiSnapshot) => void) => { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; }),
    send: vi.fn(async (_text: string, _images: string[] = []) => 101), abort: vi.fn(async () => {}),
    newSession: vi.fn(async () => {}), switchSession: vi.fn(async (_id: string | number) => {}),
    sessions: vi.fn(async () => [{ id: 17, label: 'Current work' }, { id: 18, label: 'Other work' }]),
    fork: vi.fn(async (_at?: number) => {}), compact: vi.fn(async () => {}),
    setMode: vi.fn(async (mode: 'build' | 'plan') => { emit({ mode }); }),
    answer: vi.fn(async (_questionId: number, _answer: string) => { emit({ questions: [] }); }),
    diff: vi.fn(async () => '+ added line'), files: vi.fn(async (_query: string) => ['src/app.ts', 'README.md']),
    tools: vi.fn(async () => ({ sessionId: state.sessionId, policy: 'workspace-write' as const, scheduling: 'paused' as const, availabilityBasis: 'native-selection-and-known-host-policy' as const, tools: [], extensions: [] })),
    provider: vi.fn(async () => ({ baseUrl: 'https://api.morphllm.com/v1', model: 'model', api: 'chat-completions' as const, apiKeyEnv: 'MORPH_API_KEY', authenticated: false, source: 'none' as const })),
    models: vi.fn(async (_refresh = false, _signal?: AbortSignal): Promise<ModelChoice[]> => [
      { id: 'fast-vision', name: 'Fast vision', contextWindow: 262144, input: ['text', 'image'], source: 'provider' },
      { id: 'private-model', name: 'Private model', source: 'provider' },
    ]),
    setModel: vi.fn(async (model: ModelChoice) => { emit({ model: model.id }); }),
  } satisfies Client;
  return { client, emit, listeners };
}
async function openView(width = 120, height = 36, state = initialState(), options: TuiOptions = {}) {
  const setup = await testing.createTestRenderer({ width, height, screenMode: 'alternate-screen', exitOnCtrlC: false, exitSignals: [], kittyKeyboard: true, useMouse: false });
  const mock = mockClient(state);
  const app = new MorphessTui(setup.renderer, mock.client, options);
  active.push({ app, setup });
  await settle(setup);
  return { app, setup, ...mock };
}
async function settle(setup: TestRendererSetup): Promise<void> {
  await setup.renderOnce();
  await setup.flush({ maxPasses: 80 });
  await setup.renderOnce();
}

describe.skipIf(!supported)('native OpenTUI view (Node 26.4+ with --experimental-ffi)', () => {
  beforeAll(async () => {
    native = await import('@opentui/core');
    testing = await import('@opentui/core/testing');
    ({ MorphessTui } = await import('../src/tui/app.js'));
  });
  afterEach(async () => {
    for (const { app, setup } of active.splice(0).reverse()) {
      try { await app.close(); } finally { await setup.dispose(); }
    }
  });
  afterAll(async () => { await native?.destroyTreeSitterClient(); });

  it.each([[120, 36], [60, 20]])('renders welcome, composer and shortcuts within %ix%i cells', async (width, height) => {
    const { app, setup } = await openView(width, height);
    const frame = setup.captureCharFrame();
    expect(frame).toContain('morphess');
    expect(frame).toContain('New session');
    expect(frame).toContain('Enter send');
    expect(frame).toContain('workspace-write');
    expect(app.composer.visible).toBe(true);
    expect(app.composer.focused).toBe(true);
    const spans = setup.captureSpans();
    expect(spans.cols).toBe(width); expect(spans.rows).toBe(height);
    expect(app.composer.y).toBeGreaterThanOrEqual(0);
    expect(app.composer.y + app.composer.height).toBeLessThanOrEqual(height);
    expect(app.root.findDescendantById('welcome')?.visible).toBe(true);
  });

  it('submits Enter, inserts Shift+Enter and keeps the composer focused', async () => {
    const { app, setup, client } = await openView();
    await setup.mockInput.typeText('First line');
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText('Second line');
    await settle(setup);
    expect(app.composer.plainText).toBe('First line\nSecond line');
    expect(client.send).not.toHaveBeenCalled();
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(client.send).toHaveBeenCalledExactlyOnceWith('First line\nSecond line', []);
    expect(app.composer.plainText).toBe('');
    expect(app.composer.focused).toBe(true);
  });

  it('shows the bundled launch mark on resumed sessions and dismisses it without losing input', async () => {
    const { app, setup } = await openView(120, 36, initialState({ entries: [{ id: 'existing', role: 'user', text: 'Previous work', status: 'done', revision: 1 }] }), { launchMark: true });
    expect(setup.captureCharFrame()).toContain('Opening session');
    expect(setup.captureCharFrame()).toContain('not official or Morph-backed');
    expect(app.transcript.visible).toBe(false);
    await setup.mockInput.typeText('Continue'); await settle(setup);
    expect(app.composer.plainText).toBe('Continue');
    expect(app.transcript.visible).toBe(true);
    expect(setup.captureCharFrame()).toContain('Previous work');
  });

  it('filters the command palette with the keyboard and restores composer input on Escape', async () => {
    const { app, setup, client, emit } = await openView();
    await setup.mockInput.typeText('Keep this draft');
    setup.mockInput.pressKey('p', { ctrl: true }); await settle(setup);
    expect(app.paletteInput.focused).toBe(true);
    expect(setup.captureCharFrame()).toContain('Commands');
    await setup.mockInput.typeText('new session'); await settle(setup);
    expect(app.paletteList.options[0]?.name).toBe('New session');
    setup.mockInput.pressEscape(); await settle(setup);
    expect(app.composer.focused).toBe(true);
    expect(app.composer.plainText).toBe('Keep this draft');
    expect(client.abort).not.toHaveBeenCalled();
    emit({ busy: true });
    setup.mockInput.pressKey('p', { ctrl: true }); await settle(setup);
    setup.mockInput.pressEscape(); await settle(setup);
    expect(client.abort).not.toHaveBeenCalled();
    setup.mockInput.pressEscape(); await settle(setup);
    expect(client.abort).toHaveBeenCalledTimes(1);
  });

  it('runs a command selected from the palette without sending it as a prompt', async () => {
    const { app, setup, client } = await openView();
    setup.mockInput.pressKey('p', { ctrl: true }); await settle(setup);
    await setup.mockInput.typeText('new session'); await settle(setup);
    setup.mockInput.pressEnter(); await settle(setup);
    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(client.send).not.toHaveBeenCalled();
    expect(app.composer.focused).toBe(true);
  });

  it('selects the current search result when query and Enter arrive in one input batch', async () => {
    const { setup, client } = await openView();
    setup.mockInput.pressKey('p', { ctrl: true }); await settle(setup);
    await setup.mockInput.pressKeys([... 'Provider', '\r']);
    await settle(setup);
    expect(client.provider).toHaveBeenCalledTimes(1);
    expect(client.newSession).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
    expect(setup.captureCharFrame()).toContain('Endpoint: https://api.morphllm.com/v1');
  });

  it('cycles Code and Plan with Shift+Tab without changing the draft or opening a menu', async () => {
    const { app, setup, client } = await openView();
    app.composer.setText('Keep this draft');
    setup.mockInput.pressTab({ shift: true }); await settle(setup);
    expect(client.setMode).toHaveBeenLastCalledWith('plan');
    expect(setup.captureCharFrame()).toContain('PLAN');
    setup.mockInput.pressTab({ shift: true }); await settle(setup);
    expect(client.setMode).toHaveBeenLastCalledWith('build');
    expect(setup.captureCharFrame()).toContain('CODE');
    expect(app.composer.plainText).toBe('Keep this draft'); expect(client.send).not.toHaveBeenCalled();
    setup.mockInput.pressKey('p', { ctrl: true }); await settle(setup);
    setup.mockInput.pressTab({ shift: true }); setup.mockInput.pressTab({ shift: true }); await settle(setup);
    expect(client.setMode.mock.calls.slice(-2).map(call => call[0])).toEqual(['plan', 'build']);
    expect(app.composer.focused).toBe(true); expect(app.composer.plainText).toBe('Keep this draft');
    await setup.mockInput.pressKeys(['\x1b[Z']); await settle(setup);
    expect(client.setMode).toHaveBeenLastCalledWith('plan');
  });

  it('loads, searches, reviews and selects a provider model without sending a task', async () => {
    const { app, setup, client } = await openView();
    app.composer.setText('/model'); setup.mockInput.pressEnter(); await settle(setup);
    expect(client.models).toHaveBeenCalledTimes(1);
    expect(setup.captureCharFrame()).toContain('Choose model');
    await setup.mockInput.pressKeys([...'private-model', '\r']); await settle(setup);
    expect(setup.captureCharFrame()).toContain('Configured context limit');
    expect(client.setModel).not.toHaveBeenCalled();
    setup.mockInput.pressEnter(); await settle(setup);
    expect(client.setModel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'private-model' }));
    expect(setup.captureCharFrame()).toContain('private-model'); expect(client.send).not.toHaveBeenCalled();
    expect(app.composer.focused).toBe(true);
  });

  it('supports manual model IDs after discovery fails and never reopens a cancelled request', async () => {
    const { app, setup, client } = await openView();
    client.models.mockRejectedValueOnce(new Error('Model discovery returned HTTP 404'));
    app.composer.setText('/model'); setup.mockInput.pressEnter(); await settle(setup);
    expect(setup.captureCharFrame()).toContain('Model list unavailable');
    await setup.mockInput.pressKeys([...'Enter a model ID', '\r']); await settle(setup);
    await setup.mockInput.pressKeys([...'my-private-id', '\r']); await settle(setup);
    setup.mockInput.pressEnter(); await settle(setup);
    expect(client.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'my-private-id', source: 'manual' }));
    let finish!: (models: ModelChoice[]) => void;
    client.models.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    app.composer.setText('/model'); setup.mockInput.pressEnter(); await settle(setup);
    setup.mockInput.pressEscape(); await settle(setup);
    finish([{ id: 'late-model', name: 'Late', source: 'provider' }]); await settle(setup);
    expect(app.composer.focused).toBe(true); expect(app.paletteInput.visible).toBe(false);
  });

  it('keeps the assistant Markdown node stable when usage, status or composer change', async () => {
    const entry = { id: 'answer-1', role: 'assistant' as const, text: 'The implementation is **complete**.', status: 'done' as const, revision: 1 };
    const { app, setup, emit } = await openView(120, 36, initialState({ entries: [entry] }));
    await vi.waitFor(async () => { await setup.renderOnce(); expect(setup.captureCharFrame()).toContain('The implementation is'); }, { timeout: 5000, interval: 20 });
    const body = app.root.findDescendantById('body-answer-1');
    expect(body).toBeInstanceOf(native.MarkdownRenderable);
    emit({ status: 'Checking files', usage: { input: 1800, output: 85, cacheRead: 200, cost: 0.02 } });
    await setup.mockInput.typeText('A follow-up draft'); await settle(setup);
    expect(app.root.findDescendantById('body-answer-1')).toBe(body);
    expect(setup.captureCharFrame()).toContain('The implementation is');
    expect(app.composer.plainText).toBe('A follow-up draft');
    expect(app.transcript.visible).toBe(true);
    expect(app.root.findDescendantById('welcome')?.visible).toBe(false);
  });

  it('replies to a pending question using a numbered option, then accepts freeform answers', async () => {
    const question = { id: 9, taskId: 9, conversationId: 17, question: 'Which database should I use?', options: ['SQLite', 'Postgres'], createdAt: 1, status: 'pending' } as TuiSnapshot['questions'][number];
    const { app, setup, client, emit } = await openView(120, 36, initialState({ questions: [question], busy: true }));
    expect(setup.captureCharFrame()).toContain('Which database should I use?');
    expect(setup.captureCharFrame()).toContain('1 SQLite');
    setup.mockInput.pressKey('r', { ctrl: true }); await settle(setup);
    expect(setup.captureCharFrame()).toContain('Question · session 17');
    expect(setup.captureCharFrame()).toContain('2. Postgres');
    setup.mockInput.pressEscape(); await settle(setup);
    await setup.mockInput.typeText('2'); setup.mockInput.pressEnter(); await settle(setup);
    expect(client.answer).toHaveBeenCalledExactlyOnceWith(9, 'Postgres');
    expect(client.send).not.toHaveBeenCalled();
    expect(app.root.findDescendantById('question')?.visible).toBe(false);
    emit({ questions: [{ ...question, id: 10, question: 'Any additional constraints?', options: [] }] });
    await settle(setup);
    await setup.mockInput.typeText('Keep the data local'); setup.mockInput.pressEnter(); await settle(setup);
    expect(client.answer).toHaveBeenLastCalledWith(10, 'Keep the data local');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('toggles the inspector, hides it on narrow terminals and changes theme without replacing rows', async () => {
    const preferences = defaultPreferences();
    const { app, setup } = await openView(120, 36, initialState({ entries: [{ id: 'stable', role: 'assistant', text: 'File updated.', status: 'done', revision: 1 }] }), { preferences });
    const body = app.root.findDescendantById('body-stable');
    const inspector = app.root.findDescendantById('inspector');
    expect(inspector?.visible).toBe(false);
    setup.mockInput.pressKey('b', { ctrl: true }); await settle(setup);
    expect(inspector?.visible).toBe(true);
    expect(setup.captureCharFrame()).toContain('SESSION 17');
    setup.resize(60, 20); await settle(setup);
    expect(inspector?.visible).toBe(false);
    setup.resize(120, 36); await settle(setup);
    expect(inspector?.visible).toBe(true);
    app.composer.setText('/theme light'); setup.mockInput.pressEnter(); await settle(setup);
    expect(preferences.theme).toBe('light');
    expect(app.root.backgroundColor.equals(native.RGBA.fromHex(THEMES.light.background))).toBe(true);
    expect(app.root.findDescendantById('body-stable')).toBe(body);
    const frame = setup.captureSpans();
    expect(frame.lines.flatMap(line => line.spans).some(span => span.bg.equals(native.RGBA.fromHex(THEMES.light.background)))).toBe(true);
  });

  it('restores the target session draft when /new switches conversations', async () => {
    const preferences = { ...defaultPreferences(), drafts: { '17': 'Source draft', '18': 'Target draft' } };
    const { app, setup, client, emit } = await openView(120, 36, initialState(), { preferences });
    client.newSession.mockImplementationOnce(async () => { emit({ sessionId: 18 }); });
    app.composer.setText('/new'); setup.mockInput.pressEnter(); await settle(setup);
    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(app.composer.plainText).toBe('Target draft');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('prevents duplicate pending submissions and retains edits made while sending', async () => {
    const { app, setup, client } = await openView();
    let finish!: (id: number) => void;
    client.send.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    await setup.mockInput.typeText('First request'); setup.mockInput.pressEnter(); await settle(setup);
    expect(client.send).toHaveBeenCalledTimes(1);
    app.composer.setText('A newer unsent draft'); setup.mockInput.pressEnter(); await settle(setup);
    expect(client.send).toHaveBeenCalledTimes(1);
    finish(101); await settle(setup);
    expect(app.composer.plainText).toBe('A newer unsent draft');
  });

  it('retains a switched session draft while a previous session send completes', async () => {
    const preferences = { ...defaultPreferences(), drafts: { '18': 'Other session draft' } };
    const { app, setup, client, emit } = await openView(120, 36, initialState(), { preferences });
    let finish!: (id: number) => void;
    client.send.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    await setup.mockInput.typeText('Original request'); setup.mockInput.pressEnter(); await settle(setup);
    emit({ sessionId: 18 }); await settle(setup);
    expect(app.composer.plainText).toBe('Other session draft');
    finish(101); await settle(setup);
    expect(app.composer.plainText).toBe('Other session draft');
  });

  it('shows send failures and preserves the prompt for a keyboard retry', async () => {
    const { app, setup, client } = await openView();
    client.send.mockRejectedValueOnce(new Error('Endpoint unavailable'));
    await setup.mockInput.typeText('Retry this request'); setup.mockInput.pressEnter(); await settle(setup);
    expect(setup.captureCharFrame()).toContain('Endpoint unavailable');
    expect(app.composer.plainText).toBe('Retry this request');
    setup.mockInput.pressEnter(); await settle(setup);
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(app.composer.plainText).toBe('');
  });

  it('detaches the view subscription and does not invoke callbacks after closing', async () => {
    const onExit = vi.fn();
    const { app, setup, listeners, client } = await openView(120, 36, initialState(), { onExit });
    expect(listeners.size).toBe(1);
    await app.close();
    expect(listeners.size).toBe(0);
    setup.mockInput.pressKey('n', { ctrl: true });
    setup.mockInput.pressKey('q', { ctrl: true });
    await settle(setup);
    expect(client.newSession).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });
});
