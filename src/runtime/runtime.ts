import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import {
  AgentDoc, AssistantEntry, configure, createRegistry, Harness, LiveDoc, type Conversation, type ConversationId,
  type EntryId, type Extension, type ModelRef, type RegistryReader, type Storage, type SubmissionDraft,
} from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { morphessConfigSchema, type MorphessConfig } from '../config.js';
import { createContextSettings, estimateContextBudget } from '../context/budget.js';
import { createModelRuntime } from '../models/runtime.js';
import { discoverModels, profileForChoice, validateModelId, type ModelChoice } from '../models/catalog.js';
import { providerCredentialDirectory } from '../models/credentials.js';
import { createDelegationExtension } from '../extensions/delegation.js';
import { loadExtensions } from '../extensions/loader.js';
import { connectMcpServers } from '../mcp/index.js';
import { createWorkspaceEnvironment } from '../policy/workspace.js';
import { createWorkspaceTools } from '../tools/workspace.js';
import { createToolCatalog, type ToolCatalogOptions, type ToolOrigin } from '../tools/catalog.js';
import { createInstructionExtension } from '../instructions/workspace.js';
import { createWorkExtension } from '../workflow/work.js';
import { createBudgetAdmission, withBudget } from './budgets.js';
import { createPersona } from './prompt.js';
import { ModelProfilesDoc, WorkspaceDoc } from './state.js';
import { parseRecordId } from './ids.js';
import { createConcurrencyExtension } from './concurrency.js';
import { createQuestionsExtension, createNonInteractiveQuestionsExtension } from '../interaction/index.js';

export interface RuntimeOptions {
  models?: Models;
  model?: ModelRef;
  storage?: Storage;
  extensions?: Extension[];
  /** Tune only when the host can guarantee bounded event-loop pauses; stale lock recovery is time based. */
  writerLock?: { staleMs: number; updateMs?: number };
  onReport?: (error: unknown, info: unknown) => void;
  /** Line-oriented/batch hosts ask for missing input in final text rather than opening new durable questions. */
  nonInteractive?: boolean;
  /** Leave Pi scheduling paused for inspection. Progress APIs such as submit/wait still resume it. */
  resume?: boolean;
}

export class MorphessRuntime {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly config: MorphessConfig;
  readonly registry: RegistryReader;
  #origins: ReadonlyMap<string, ToolOrigin>;
  #close: () => Promise<void>;
  #closing?: Promise<void>;
  #models: Models;
  #registerModel?: (profile: MorphessConfig['model']) => void;
  #profiles: Map<string, MorphessConfig['model']>;
  #catalog?: { expires: number; choices: ModelChoice[] };

  private constructor(config: MorphessConfig, harness: Harness, root: Conversation, registry: RegistryReader, origins: ReadonlyMap<string, ToolOrigin>, close: () => Promise<void>, models: Models, profiles: Map<string, MorphessConfig['model']>, registerModel?: (profile: MorphessConfig['model']) => void) {
    this.config = config; this.harness = harness; this.root = root; this.registry = registry; this.#origins = origins; this.#close = close;
    this.#models = models; this.#profiles = profiles; this.#registerModel = registerModel;
  }

  static async open(input: MorphessConfig, options: RuntimeOptions = {}): Promise<MorphessRuntime> {
    const config = morphessConfigSchema.parse(input);
    config.workspace = await realpath(config.workspace);
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    config.stateDir = await realpath(config.stateDir);
    await chmod(config.stateDir, 0o700);
    const cleanups: Array<() => Promise<void>> = [];
    let harness: Harness | undefined;
    try {
      const release = await lockfile.lock(config.stateDir, {
        retries: 0, stale: options.writerLock?.staleMs ?? 120_000, update: options.writerLock?.updateMs ?? 10_000,
        onCompromised: (error) => {
          options.onReport?.(error, { type: 'writer_lock_compromised' });
          void harness?.close(BACKGROUND_CONTEXT);
        },
      });
      cleanups.push(release);
      const modelRuntime = options.models
        ? { models: options.models, model: options.model ?? { provider: 'faux', modelId: 'faux-1' } }
        : createModelRuntime(config);
      const registerModel = 'registerModel' in modelRuntime ? modelRuntime.registerModel : undefined;
      const profiles = new Map([[config.model.id, config.model]]);
      const settings = () => ({
        ...createContextSettings(config), toolExecution: 'parallel' as const, restartLimit: 5,
        contextRetentionMs: 60_000, documentRetentionMs: 60_000, afterFailedRun: 'withdraw' as const,
        progress: { partialIntervalMs: 100, outputIntervalMs: 150 },
        compaction: { ...createContextSettings(config).compaction, modelOverrides: Object.fromEntries([...profiles].map(([id, profile]) => {
          const reserveTokens = Math.max(profile.maxOutputTokens, Math.min(config.context.reserveTokens, Math.floor(profile.contextWindow / 4)));
          const keepRecentTokens = Math.min(config.context.keepRecentTokens, Math.floor(profile.contextWindow / 4));
          return [`${modelRuntime.model.provider}/${id}`, { reserveTokens, keepRecentTokens, backgroundTokens: Math.max(0, Math.min(keepRecentTokens, Math.floor((profile.contextWindow - reserveTokens - keepRecentTokens) / 4))) }];
        })) },
      });
      const protectedPaths = [config.stateDir, providerCredentialDirectory()];
      const env = await createWorkspaceEnvironment({ workspace: config.workspace, ...config.policy, protectedPaths });
      cleanups.push(() => env.cleanup(BACKGROUND_CONTEXT));
      const registry = createRegistry();
      registry.install(CodingTools);
      registry.install(createWorkspaceTools({ workspace: config.workspace, maxOutputBytes: config.policy.maxOutputBytes }));
      registry.install(createPersona(config.policy.mode));
      registry.install(await createInstructionExtension({ workspace: config.workspace, protectedPaths }));
      registry.install(createWorkExtension());
      registry.install(createQuestionsExtension({ getHarness: () => {
        if (!harness) throw new Error('Harness is not open');
        return harness;
      } }));
      // Always register the stable extension name: child selections persist across host types.
      registry.install(createNonInteractiveQuestionsExtension({ enabled: options.nonInteractive === true }));
      registry.install(createDelegationExtension(config.limits));
      registry.install(createToolSearchExtension());
      if (config.codemode) {
        const sandbox = new CodemodeSandbox({ memoryLimitBytes: 128 * 1024 * 1024 });
        cleanups.push(async () => { await sandbox.close(); });
        registry.install(createCodemodeExtension({ sandbox, models: false, inlineBudget: 3_000 }));
      }
      const origins = new Map<string, ToolOrigin>(registry.snapshot().installed().map(extension => [extension.name, 'builtin']));
      const plugins = await loadExtensions(config.plugins, { workspace: config.workspace });
      cleanups.push(() => plugins.close());
      for (const extension of plugins.extensions) { registry.install(extension); origins.set(extension.name, 'plugin'); }
      const mcp = await connectMcpServers(config.mcp, { stateDir: config.stateDir, onExtensionsChanged: extension => { registry.install(extension); origins.set(extension.name, 'mcp'); } });
      cleanups.push(() => mcp.close());
      for (const extension of mcp.extensions) { registry.install(extension); origins.set(extension.name, 'mcp'); }
      for (const extension of options.extensions ?? []) { registry.install(extension); origins.set(extension.name, 'host'); }
      // MCP owns bounded per-server admission and may wait on nested human input.
      // Holding a regular execution permit across that wait could starve local work.
      const localTools = registry.snapshot().tools().filter(({ extension }) => origins.get(extension.name) !== 'mcp').map(({ tool }) => tool);
      const concurrency = createConcurrencyExtension(localTools, Math.max(2, config.limits.maxConcurrentAgents));
      registry.install(concurrency); origins.set(concurrency.name, 'builtin');
      const admit = createBudgetAdmission(() => {
        if (!harness) throw new Error('Harness is not open');
        return harness;
      }, config.limits);
      const storage = options.storage ?? await openNodeSqliteStorage(join(config.stateDir, 'session.sqlite'));
      // Harness owns storage after open. Close it separately only if construction fails.
      try {
        harness = await Harness.open(storage, {
          models: withBudget(modelRuntime.models, admit, config.limits.maxConcurrentAgents + 2), registry, env: () => env,
          identity: { attribution: { name: 'Morphess', url: 'https://github.com/Belweave/morphess', categories: ['cli-agent'] } },
          settings,
          onReport: (error, info) => options.onReport?.(error, info),
        }, BACKGROUND_CONTEXT);
      } catch (error) { await storage.close(BACKGROUND_CONTEXT).catch(() => {}); throw error; }
      const opened = harness;
      cleanups.push(() => opened.close(BACKGROUND_CONTEXT));
      await opened.commit(async (tx) => {
        const state = await tx.doc(WorkspaceDoc);
        if (state.workspace && state.workspace !== config.workspace) {
          throw new Error('This state directory belongs to a different workspace. Use a separate stateDir.');
        }
        state.workspace = config.workspace;
      }, BACKGROUND_CONTEXT);
      const root = await opened.root(BACKGROUND_CONTEXT, { agent: { model: modelRuntime.model, cwd: config.workspace } });
      let restoreChoice = false;
      if (registerModel) await opened.commit(async tx => {
        const saved = await tx.doc(ModelProfilesDoc);
        const sameProvider = saved.endpoint === config.model.baseUrl && saved.api === config.model.api;
        restoreChoice = sameProvider && saved.defaultId === config.model.id;
        if (sameProvider) for (const profile of saved.profiles.slice(0, 128)) {
          if (profile.id === config.model.id || profile.baseUrl !== config.model.baseUrl || profile.api !== config.model.api) continue;
          profile.apiKeyEnv = config.model.apiKeyEnv;
          const validated = morphessConfigSchema.parse({ ...config, model: profile, context: { ...config.context, reserveTokens: Math.min(config.context.reserveTokens, Math.floor(profile.contextWindow / 4)), keepRecentTokens: Math.min(config.context.keepRecentTokens, Math.floor(profile.contextWindow / 4)) } }).model;
          registerModel(validated); profiles.set(validated.id, validated);
        }
        else { saved.endpoint = config.model.baseUrl; saved.api = config.model.api; saved.defaultId = config.model.id; saved.profiles = []; }
        saved.defaultId = config.model.id;
      }, BACKGROUND_CONTEXT);
      await root.configure({ ...(restoreChoice ? {} : { model: modelRuntime.model }), cwd: config.workspace }, BACKGROUND_CONTEXT);
      if (!options.storage) await chmod(join(config.stateDir, 'session.sqlite'), 0o600);
      if (options.resume !== false) opened.resume();
      const close = async () => {
        const errors: unknown[] = [];
        for (const cleanup of cleanups.reverse()) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Runtime cleanup failed');
      };
      return new MorphessRuntime(config, opened, root, registry, origins, close, modelRuntime.models, profiles, registerModel);
    } catch (error) {
      for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
      throw error;
    }
  }

  async conversation(id?: string | number, context = BACKGROUND_CONTEXT): Promise<Conversation> {
    if (id === undefined || id === 'root') return this.root;
    const conversation = await this.harness.conversation(parseRecordId(id) as ConversationId, context);
    if (!conversation) throw new Error(`Conversation not found: ${id}`);
    return conversation;
  }

  async toolCatalog(options: ToolCatalogOptions = {}, context = BACKGROUND_CONTEXT) {
    const conversation = await this.conversation(options.sessionId, context);
    const [agent, state, inspection] = await Promise.all([
      conversation.agent(context), this.harness.snapshot(AgentDoc, conversation.id, context), this.harness.inspect(context),
    ]);
    return createToolCatalog(this.registry.snapshot(), agent, state ?? {}, {
      sessionId: conversation.id, policy: this.config.policy.mode, scheduling: inspection.scheduling, origins: this.#origins,
    }, options);
  }

  async createConversation(instructions?: string): Promise<Conversation> {
    const rootAgent = await this.root.agent(BACKGROUND_CONTEXT);
    return this.harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { model: rootAgent.model, cwd: this.config.workspace, instructions },
    }, BACKGROUND_CONTEXT);
  }

  async submit(draft: SubmissionDraft, id?: string | number, context = BACKGROUND_CONTEXT) {
    const conversation = await this.conversation(id, context);
    return conversation.submit(draft, context);
  }

  async answer(submissionId: string | number, context: Context = BACKGROUND_CONTEXT) {
    const submission = await this.harness.submission(parseRecordId(submissionId) as Parameters<Harness['submission']>[0], context);
    if (!submission) throw new Error(`Submission not found: ${submissionId}`);
    const settled = await submission.wait(context);
    if (settled.status !== 'done' || settled.type !== 'input') return { submission: settled, text: '' };
    const entry = await this.harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
    const message = entry?.model?.[0];
    const text = message?.role === 'assistant'
      ? message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('') : '';
    return { submission: settled, text, entry };
  }

  async fork(id: string | number, at: string | number) {
    return (await this.conversation(id)).fork(parseRecordId(at) as EntryId, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
  }

  async contextBudget(id?: string | number) {
    const conversation = await this.conversation(id);
    const profile = await this.modelProfile(conversation.id);
    return estimateContextBudget({ ...this.config, model: profile, context: { ...this.config.context, reserveTokens: Math.min(this.config.context.reserveTokens, Math.floor(profile.contextWindow / 4)) } }, (await conversation.context(BACKGROUND_CONTEXT)).messages);
  }

  async modelProfile(id?: string | number): Promise<MorphessConfig['model']> {
    const agent = await (await this.conversation(id)).agent(BACKGROUND_CONTEXT);
    return this.#profiles.get(agent.model?.modelId ?? '') ?? this.config.model;
  }

  async models(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelChoice[]> {
    if (!this.#registerModel) return this.#models.getModels().map(model => ({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, input: model.input, reasoning: model.reasoning, source: 'configured' }));
    if (!options.refresh && this.#catalog && this.#catalog.expires > Date.now()) return this.#catalog.choices;
    const remote = await discoverModels(this.config.model, options);
    const configured: ModelChoice[] = [...this.#profiles.values()].map(base => ({ id: base.id, name: base.id, contextWindow: base.contextWindow, maxOutputTokens: base.maxOutputTokens, input: base.input, reasoning: base.reasoning, source: 'configured' }));
    const choices = [...configured, ...remote.filter(model => !this.#profiles.has(model.id))];
    this.#catalog = { expires: Date.now() + 60_000, choices }; return choices;
  }

  async selectModel(choice: ModelChoice, id?: string | number, context = BACKGROUND_CONTEXT): Promise<void> {
    validateModelId(choice.id);
    if (!this.#registerModel) throw new Error('This host uses an injected model provider; change its model through the host');
    if (this.config.limits.maxSpendUsd !== undefined && choice.id !== this.config.model.id) throw new Error('Set explicit prices for the new model before switching a host with a spend limit');
    const profile = profileForChoice(this.config, choice);
    const validated = morphessConfigSchema.parse({ ...this.config, model: profile, context: { ...this.config.context, reserveTokens: Math.min(this.config.context.reserveTokens, Math.floor(profile.contextWindow / 4)), keepRecentTokens: Math.min(this.config.context.keepRecentTokens, Math.floor(profile.contextWindow / 4)) } }).model;
    const conversation = await this.conversation(id, context);
    const transcript = (await conversation.context(context)).messages;
    if (!profile.input.includes('image') && transcript.some(message => typeof message.content !== 'string' && message.content.some(block => block.type === 'image')))
      throw new Error('This session contains images. Choose a vision model or start a new session for a text-only model.');
    const budget = estimateContextBudget({ ...this.config, model: profile, context: { ...this.config.context, reserveTokens: Math.min(this.config.context.reserveTokens, Math.floor(profile.contextWindow / 4)) } }, transcript);
    if (transcript.length && budget.shouldCompact) throw new Error('The session exceeds this model’s context budget. Compact the current session or start a new one before switching.');
    await conversation.commit(async tx => {
      const live = await tx.doc(LiveDoc, conversation.id);
      if (live.run || live.compactions?.length) throw new Error('Stop active work before switching models');
      const saved = await tx.doc(ModelProfilesDoc);
      if (!saved.profiles.some(item => item.id === profile.id) && saved.profiles.length >= 128) throw new Error('This workspace already has 128 selected model profiles');
      saved.profiles = [...saved.profiles.filter(item => item.id !== profile.id), validated];
      await configure(tx, conversation.id, { model: { provider: 'morphess', modelId: validated.id } });
    }, context);
    this.#registerModel(validated); this.#profiles.set(validated.id, validated);
    if (this.#catalog) this.#catalog.choices = [...this.#catalog.choices.filter(model => model.id !== validated.id), { ...choice, contextWindow: validated.contextWindow, maxOutputTokens: validated.maxOutputTokens, input: validated.input, reasoning: validated.reasoning, source: 'configured' }];
  }

  close(): Promise<void> { return this.#closing ??= this.#close(); }
}

export const openRuntime = MorphessRuntime.open;
