import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { ConversationBusy, StorageRequestError, watchEvents, type Conversation, type Cursor, type ModelRef } from '@earendil-works/pi-durable';
import { MorphessRuntime } from '../runtime/runtime.js';
import { parseRecordId } from '../runtime/ids.js';
import { chatRequestSchema, fromOpenAIContent, inputContentSchema } from './input.js';
import { acquireChatConversation } from './idempotency.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use application/json');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 24 * 1024 * 1024) throw new HttpError(413, 'Request exceeds 24 MiB');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const value = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return value.length === expected.length && timingSafeEqual(value, expected);
}

function sseHeaders(response: ServerResponse) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  response.flushHeaders();
}

async function writeFrame(response: ServerResponse, value: unknown, event?: string): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  const frame = `${event ? `event: ${event}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
  if (!response.write(frame)) {
    // A stalled consumer must not retain a watch and arbitrarily large transcript forever.
    const signal = AbortSignal.timeout(30_000);
    try { await once(response, 'drain', { signal }); }
    catch { response.destroy(); }
  }
}

function safeError(error: unknown): { status: number; message: string } {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof ConversationBusy) return { status: 409, message: 'Conversation is busy' };
  if (error instanceof StorageRequestError) return { status: 400, message: 'Invalid record or cursor' };
  if (error instanceof Error && error.message.startsWith('Idempotency-Key already used')) return { status: 409, message: error.message };
  if (error instanceof z.ZodError) return { status: 400, message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
  if (error instanceof Error && /^(Expected |Conversation not found:|Submission not found:|Images require |This model profile|Image input|Conversation history |The last message |System instructions |Idempotency-Key must)/.test(error.message)) return { status: 400, message: error.message };
  return { status: 500, message: 'Request failed. Inspect host diagnostics.' };
}

export interface ServeOptions {
  host?: string;
  port?: number;
  token?: string;
  maxEventStreams?: number;
  onError?: (error: unknown) => void;
}

export async function serve(runtime: MorphessRuntime, options: ServeOptions = {}) {
  const host = options.host ?? runtime.config.server.host;
  const port = options.port ?? runtime.config.server.port;
  const token = options.token ?? process.env[runtime.config.server.tokenEnv];
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !token) throw new Error('Non-loopback listeners require a server bearer token');
  const streams = new Set<ServerResponse>();
  let healthy = true;
  void runtime.harness.closed.then(() => { healthy = false; });
  const active = new Set<Promise<void>>();
  const maxStreams = options.maxEventStreams ?? 32;
  const server = createServer((request, response) => {
    if (active.size >= 64) { json(response, 503, { error: { message: 'Host request capacity reached' } }); return; }
    const handling = handle(request, response).catch((error: unknown) => {
      if (response.destroyed) return;
      const safe = safeError(error);
      if (safe.status === 500) options.onError?.(error);
      if (response.headersSent) { void writeFrame(response, { error: { message: safe.message } }).finally(() => response.end()); }
      else json(response, safe.status, { error: { message: safe.message, type: safe.status === 401 ? 'authentication_error' : 'invalid_request_error' } });
    }).finally(() => active.delete(handling));
    active.add(handling);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authority = request.headers.host;
    if (!authority) throw new HttpError(400, 'Host header required');
    let url: URL;
    try { url = new URL(request.url ?? '/', `http://${authority}`); }
    catch { throw new HttpError(400, 'Invalid request URL'); }
    if (!token && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new HttpError(403, 'Invalid loopback host');
    // This is a headless API. No ambient browser-origin authority or permissive CORS.
    if (request.headers.origin) throw new HttpError(403, 'Browser origins are not enabled');
    if (url.pathname === '/health' && request.method === 'GET') { json(response, healthy ? 200 : 503, { status: healthy ? 'ok' : 'unavailable' }); return; }
    if (token && !bearerMatches(request.headers.authorization, token)) throw new HttpError(401, 'Invalid bearer token');
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      json(response, 200, { object: 'list', data: [{ id: runtime.config.model.id, object: 'model', created: 0, owned_by: 'belweave', context_window: runtime.config.model.contextWindow, modalities: runtime.config.model.input }] }); return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/sessions') {
      const page = await runtime.harness.commit((tx) => tx.scanConversations({}, boundedLimit(url), readCursor(url)), BACKGROUND_CONTEXT);
      json(response, 200, { items: page.items, next: page.next ? Buffer.from(JSON.stringify(page.next)).toString('base64url') : undefined }); return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      const data = z.strictObject({ instructions: z.string().max(100_000).optional() }).parse(await body(request));
      const conversation = await runtime.createConversation(data.instructions);
      json(response, 201, { id: conversation.id }); return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/usage') { json(response, 200, await runtime.harness.usage(BACKGROUND_CONTEXT)); return; }
    if (request.method === 'GET' && url.pathname === '/v1/tasks') { json(response, 200, await runtime.harness.inspect(BACKGROUND_CONTEXT)); return; }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') { await chat(request, response); return; }

    const submissionMatch = /^\/v1\/submissions\/(\d+)$/.exec(url.pathname);
    if (submissionMatch && request.method === 'GET') {
      const id = parseRecordId(submissionMatch[1]!);
      if (url.searchParams.get('wait') === 'true') {
        const controller = new AbortController();
        response.once('close', () => controller.abort());
        json(response, 200, await runtime.answer(id, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)));
      } else {
        const submission = await runtime.harness.submission(id as Parameters<typeof runtime.harness.submission>[0], BACKGROUND_CONTEXT);
        if (!submission) throw new HttpError(404, 'Submission not found');
        json(response, 200, await submission.status(BACKGROUND_CONTEXT));
      }
      return;
    }
    const sessionMatch = /^\/v1\/sessions\/(root|\d+)\/(inputs|entries|events|abort|compact|fork|context)$/.exec(url.pathname);
    if (!sessionMatch) throw new HttpError(404, 'Route not found');
    const conversation = await runtime.conversation(sessionMatch[1]!);
    const action = sessionMatch[2];
    if (action === 'inputs' && request.method === 'POST') {
      const data = z.strictObject({ content: inputContentSchema, requestId: z.string().min(1).max(256).optional(), whenBusy: z.enum(['steer', 'followUp', 'reject']).optional() }).parse(await body(request));
      validateImages(data.content);
      const submission = await conversation.submit({ type: 'input', ...data }, BACKGROUND_CONTEXT);
      json(response, 202, { id: submission.id, conversationId: conversation.id }); return;
    }
    if (action === 'entries' && request.method === 'GET') {
      const cursor = readCursor(url);
      const page = await conversation.entries({ order: 'ascending' }, boundedLimit(url), cursor, BACKGROUND_CONTEXT);
      json(response, 200, { items: page.items, next: page.next ? Buffer.from(JSON.stringify(page.next)).toString('base64url') : undefined }); return;
    }
    if (action === 'context' && request.method === 'GET') { json(response, 200, await runtime.contextBudget(conversation.id)); return; }
    if (action === 'abort' && request.method === 'POST') { await conversation.abort(BACKGROUND_CONTEXT, { background: true }); json(response, 200, { status: 'aborted' }); return; }
    if (action === 'compact' && request.method === 'POST') {
      const data = z.strictObject({ instructions: z.string().max(10_000).optional() }).parse(await body(request));
      json(response, 202, { taskId: await conversation.compact(data.instructions, BACKGROUND_CONTEXT) }); return;
    }
    if (action === 'fork' && request.method === 'POST') {
      const data = z.strictObject({ at: z.union([z.string(), z.number().int()]) }).parse(await body(request));
      json(response, 201, { id: (await runtime.fork(conversation.id, data.at)).id }); return;
    }
    if (action === 'events' && request.method === 'GET') { await events(conversation, response); return; }
    throw new HttpError(405, 'Method not allowed');
  }

  function validateImages(content: string | Array<{ type: string }>) {
    if (typeof content !== 'string' && content.some((part) => part.type === 'image') && !runtime.config.model.input.includes('image')) throw new HttpError(400, 'This model profile does not declare image input');
  }

  async function events(conversation: Conversation, response: ServerResponse) {
    if (streams.size >= maxStreams) throw new HttpError(429, 'Too many event streams');
    streams.add(response);
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    let watch: Awaited<ReturnType<typeof watchEvents>> | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      watch = await watchEvents(runtime.harness, conversation.id, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
      heartbeat = setInterval(() => { if (!response.destroyed && response.writableLength < 64_000) response.write(': keepalive\n\n'); }, 15_000);
      heartbeat.unref();
      sseHeaders(response);
      // Transcript comes from the paginated entries API; snapshots hold control state only.
      const { entries: _entries, ...snapshot } = watch.snapshot;
      await writeFrame(response, snapshot, 'snapshot');
      watch.start(async (batch) => {
        for (const event of batch) {
          if (event.type === 'snapshot') {
            const { entries: _history, ...state } = event;
            await writeFrame(response, state, 'snapshot');
          } else await writeFrame(response, event, event.type);
        }
      });
      await watch.closed;
    } finally {
      clearInterval(heartbeat); streams.delete(response); await watch?.stop(); response.end();
    }
  }

  async function chat(request: IncomingMessage, response: ServerResponse) {
    const data = chatRequestSchema.parse(await body(request));
    if (data.stream) {
      if (streams.size >= maxStreams) throw new HttpError(429, 'Too many event streams');
      streams.add(response);
    }
    try { await chatRun(request, response, data); }
    finally { streams.delete(response); }
  }

  async function chatRun(request: IncomingMessage, response: ServerResponse, data: z.infer<typeof chatRequestSchema>) {
    if (data.model !== runtime.config.model.id) throw new HttpError(404, 'Unknown model');
    const last = data.messages.at(-1)!;
    if (last.role !== 'user') throw new Error('The last message must have role user');
    const inputs = data.messages.map((message) => ({ role: message.role, content: fromOpenAIContent(message.content) }));
    for (const input of inputs) validateImages(input.content);
    const system = inputs.filter((message) => message.role === 'system' || message.role === 'developer');
    if (system.some((message) => typeof message.content !== 'string')) throw new Error('System instructions must be strings');
    let dialogueStarted = false;
    for (const input of inputs) {
      if (input.role === 'system' || input.role === 'developer') {
        if (dialogueStarted) throw new Error('System instructions must precede dialogue');
      } else dialogueStarted = true;
    }
    if (data.conversation_id !== undefined && inputs.length !== 1) throw new Error('Conversation history is durable: send one new user message with conversation_id');
    const rootAgent = await runtime.root.agent(BACKGROUND_CONTEXT);
    const history: Message[] = [];
    if (data.conversation_id === undefined) {
      for (const input of inputs.slice(0, -1)) {
        if (input.role === 'system' || input.role === 'developer') continue;
        const message: Message = input.role === 'user'
          ? { role: 'user', content: input.content, timestamp: Date.now() }
          : importedAssistant(input.content, rootAgent.model!, runtime.config.model.api);
        history.push(message);
      }
    }
    const { conversation, requestId } = await acquireChatConversation(runtime, {
      key: request.headers['idempotency-key']?.toString(),
      fingerprint: createHash('sha256').update(JSON.stringify({ model: data.model, messages: data.messages, conversation_id: data.conversation_id })).digest('hex'),
      conversationId: data.conversation_id, instructions: system.map((message) => message.content).join('\n\n') || undefined, history,
    });
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: unknown, finishReason: string | null = null) => ({ id, object: 'chat.completion.chunk', created, model: data.model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
    response.setHeader('X-Morphess-Conversation', String(conversation.id));
    let watch: Awaited<ReturnType<typeof watchEvents>> | undefined;
    let acceptingEvents = true;
    let delivery = Promise.resolve();
    let currentText = '';
    const textBlocks = new Map<number, string>();
    let currentTimestamp: number | undefined;
    let lastEntryId: number | undefined;
    let inProgress = false;
    if (data.stream) streams.add(response);
    try {
    watch = data.stream ? await watchEvents(runtime.harness, conversation.id, context) : undefined;
    if (watch) {
      sseHeaders(response);
      await writeFrame(response, chunk({ role: 'assistant' }));
      watch.start(async (batch) => {
        delivery = delivery.then(async () => {
        for (const event of batch) {
          if (!acceptingEvents) return;
          if (event.type === 'message_start' && event.message.role === 'assistant') {
            textBlocks.clear();
            event.message.content.forEach((block, index) => { if (block.type === 'text') textBlocks.set(index, block.text); });
            currentText = [...textBlocks.values()].join(''); currentTimestamp = event.message.timestamp; inProgress = true;
            if (currentText) await writeFrame(response, chunk({ content: currentText }));
          }
          if (event.type === 'message_update') {
            for (const change of event.changes) {
              if (change.type === 'text_delta') textBlocks.set(change.contentIndex, (textBlocks.get(change.contentIndex) ?? '') + change.delta);
              else if (change.type === 'text_start' || change.type === 'block') {
                if (change.block.type === 'text') textBlocks.set(change.contentIndex, change.block.text);
                else textBlocks.delete(change.contentIndex);
              } else if (change.type === 'message') {
                textBlocks.clear();
                change.message.content.forEach((block, index) => { if (block.type === 'text') textBlocks.set(index, block.text); });
              }
            }
            const next = [...textBlocks.entries()].sort(([left], [right]) => left - right).map(([, text]) => text).join('');
            if (!next.startsWith(currentText)) throw new Error('Stream changed an already emitted text prefix');
            const delta = next.slice(currentText.length); currentText = next;
            if (delta) await writeFrame(response, chunk({ content: delta }));
          }
          if (event.type === 'message_end') {
            const message = event.entry.model?.[0];
            if (message?.role === 'assistant') {
              const text = message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('');
              const suffix = currentTimestamp === message.timestamp && text.startsWith(currentText) ? text.slice(currentText.length) : text;
              if (suffix) await writeFrame(response, chunk({ content: suffix }));
              currentText = text; currentTimestamp = message.timestamp; lastEntryId = event.entry.id; inProgress = false;
            }
          }
        }
        });
        await delivery;
      });
    }
      const submission = await conversation.submit({ type: 'input', content: inputs.at(-1)!.content, requestId, whenBusy: 'reject' }, BACKGROUND_CONTEXT);
      const answer = await runtime.answer(submission.id, context);
      acceptingEvents = false;
      await watch?.stop();
      await delivery;
      if (answer.submission.status !== 'done') throw new HttpError(502, 'Agent run ended without an answer');
      const modelMessage = answer.entry?.model?.[0];
      const usage = modelMessage?.role === 'assistant' ? modelMessage.usage : undefined;
      const usageObject = { prompt_tokens: usage?.input ?? 0, completion_tokens: usage?.output ?? 0, total_tokens: usage?.totalTokens ?? 0 };
      const finishReason = modelMessage?.role === 'assistant' && modelMessage.stopReason === 'length' ? 'length' : 'stop';
      if (data.stream) {
        const finalSeen = lastEntryId === answer.entry?.id || (inProgress && currentTimestamp === modelMessage?.timestamp);
        const suffix = finalSeen && answer.text.startsWith(currentText) ? answer.text.slice(currentText.length) : answer.text;
        if (suffix) await writeFrame(response, chunk({ content: suffix }));
        await writeFrame(response, chunk({}, finishReason));
        if (data.stream_options?.include_usage) await writeFrame(response, { id, object: 'chat.completion.chunk', created, model: data.model, choices: [], usage: usageObject });
        await writeFrame(response, '[DONE]'); response.end();
      } else json(response, 200, { id, object: 'chat.completion', created, model: data.model, choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: finishReason }], usage: usageObject, conversation_id: conversation.id });
    } finally { acceptingEvents = false; await watch?.stop(); await delivery; streams.delete(response); }
  }

  server.requestTimeout = 30_000;
  server.maxConnections = 64;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return {
    server,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`,
    close: async () => {
      for (const response of streams) response.destroy();
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      await Promise.allSettled(active);
    },
  };
}

function boundedLimit(url: URL) {
  const raw = url.searchParams.get('limit');
  const value = raw === null ? 100 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new HttpError(400, 'limit must be 1–500');
  return value;
}

function readCursor(url: URL): Cursor | undefined {
  const raw = url.searchParams.get('cursor');
  if (!raw) return undefined;
  if (raw.length > 8_192) throw new HttpError(400, 'Invalid history cursor');
  try { return z.record(z.string(), z.json()).parse(JSON.parse(Buffer.from(raw, 'base64url').toString())) as Cursor; }
  catch { throw new HttpError(400, 'Invalid history cursor'); }
}

function importedAssistant(content: ReturnType<typeof fromOpenAIContent>, model: ModelRef, api: string): AssistantMessage {
  if (typeof content !== 'string' && content.some((part) => part.type === 'image')) throw new HttpError(400, 'Assistant history supports text only');
  return {
    role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content.filter((part) => part.type === 'text'),
    provider: model.provider, model: model.modelId, api: api === 'responses' ? 'openai-responses' : 'openai-completions', timestamp: Date.now(), stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
