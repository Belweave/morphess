import { pathToFileURL } from 'node:url';
import { withAbortSignal, type Context } from '@earendil-works/chord/context';
import type { Message, Usage } from '@earendil-works/pi-ai';
import { ProviderDoc, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { Client, type ClientCapabilities } from '@modelcontextprotocol/client';
import type { McpServerConfig } from '../config.js';
import { Semaphore } from '../runtime/concurrency.js';

export interface McpInvocation { api: ToolExecutionApi; context: Context; usage?: Usage; }

/** One active request per server gives legacy push requests an unambiguous durable owner. */
export class McpInteractions {
  readonly semaphore = new Semaphore(1);
  active?: McpInvocation;
  #requests = 0;
  constructor(readonly config: McpServerConfig) {}

  capabilities(): ClientCapabilities {
    return {
      ...(this.config.elicitation ? { elicitation: { form: {}, url: {} } } : {}),
      ...(this.config.sampling ? { sampling: {} } : {}),
      ...(this.config.roots.length ? { roots: {} } : {}),
      ...(this.config.tasks ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {}),
    };
  }

  async run<T>(invocation: McpInvocation | undefined, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.semaphore.acquire(signal);
    try {
      signal.throwIfAborted();
      this.active = invocation;
      this.#requests = 0;
      return await operation();
    } finally { this.active = undefined; release(); }
  }

  #owner(signal: AbortSignal): McpInvocation {
    if (!this.active) throw new Error('MCP server input requires an active durable tool invocation');
    if (++this.#requests > Math.min(16, this.config.maxInputRounds * 2)) throw new Error('MCP server exceeded its input-request budget');
    return { ...this.active, context: withAbortSignal(signal, this.active.context) };
  }

  async #ask(invocation: McpInvocation, question: string, options?: string[]): Promise<string> {
    if (question.length > 10_000) throw new Error('MCP question exceeds the 10000-character review limit');
    const response = await invocation.api.executeTool('ask_user', { question, ...(options ? { options } : {}) }, invocation.context);
    if (response.isError || typeof response.structuredOutput !== 'string') throw new Error('MCP interaction was cancelled or could not obtain a user answer');
    return response.structuredOutput;
  }

  install(client: Client): void {
    if (this.config.roots.length) client.setRequestHandler('roots/list', async () => ({
      roots: this.config.roots.map(root => {
        const uri = root.startsWith('file:') ? new URL(root).href : pathToFileURL(root).href;
        if (!uri.startsWith('file:')) throw new Error('MCP roots must be explicit file URIs');
        return { uri };
      }),
    }));
    if (this.config.elicitation) client.setRequestHandler('elicitation/create', async (request, ctx) => {
      const owner = this.#owner(ctx.mcpReq.signal);
      const params = request.params;
      if (params.mode === 'url') {
        const url = new URL(params.url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('MCP URL elicitation requires a credential-free HTTPS URL');
        const answer = await this.#ask(owner, `MCP server ${this.config.name} requests an external interaction.\n${params.message}\nURL: ${url.href}\nOpen this URL yourself if you choose. Reply accept only after completing it, or decline/cancel. Morphess does not open or fetch it.`, ['accept', 'decline', 'cancel']);
        const action = answer.trim().toLowerCase();
        if (action !== 'accept' && action !== 'decline' && action !== 'cancel') throw new Error('Expected accept, decline, or cancel for MCP URL elicitation');
        return { action };
      }
      const answer = await this.#ask(owner, `MCP server ${this.config.name} asks:\n${params.message}\nReply with a JSON object matching this form, or decline/cancel:\n${JSON.stringify(params.requestedSchema)}`);
      const action = answer.trim().toLowerCase();
      if (action === 'decline' || action === 'cancel') return { action };
      const content: unknown = JSON.parse(answer);
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('MCP elicitation requires a JSON object');
      // The official SDK validates the accepted content against requestedSchema.
      return { action: 'accept', content: content as Record<string, string | number | boolean | string[]> };
    });
    if (this.config.sampling) client.setRequestHandler('sampling/createMessage', async (request, ctx) => {
      const owner = this.#owner(ctx.mcpReq.signal);
      const params = request.params;
      if (params.includeContext && params.includeContext !== 'none') throw new Error('MCP sampling cannot disclose conversation or other-server context');
      if (params.tools?.length) throw new Error('MCP sampling tool loops are unsupported; use ordinary durable agent tools');
      const approval = await this.#ask(owner, `MCP server ${this.config.name} requests a billed model call. Review all input below and reply approve or decline:\n${JSON.stringify(params)}`, ['approve', 'decline']);
      if (approval.trim().toLowerCase() !== 'approve') throw new Error('User declined MCP sampling');
      const agent = await owner.api.agent(owner.context);
      if (!agent.model) throw new Error('No durable model configured for MCP sampling');
      const model = owner.api.models.getModel(agent.model.provider, agent.model.modelId);
      const provider = await owner.api.snapshot(ProviderDoc, owner.api.conversationId, owner.context);
      if (!model || !provider) throw new Error('MCP sampling requires a durable provider session and model');
      const messages: Message[] = params.messages.map(message => {
        const content = Array.isArray(message.content) ? message.content : [message.content];
        if (content.some(block => block.type !== 'text' && block.type !== 'image')) throw new Error('MCP sampling supports text and image content only');
        if (message.role === 'user') return { role: 'user', content: content as Extract<Message, { role: 'user' }>['content'], timestamp: owner.api.now() };
        if (content.some(block => block.type !== 'text')) throw new Error('MCP assistant sampling history must be text');
        return { role: 'assistant', content: content as Extract<Message, { role: 'assistant' }>['content'], timestamp: owner.api.now(), api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', usage: zeroUsage() };
      });
      const result = await owner.api.models.completeSimple(model, { systemPrompt: params.systemPrompt, messages }, {
        sessionId: provider.sessionId, signal: owner.context.abortSignal,
        maxTokens: Math.min(params.maxTokens, model.maxTokens), temperature: params.temperature,
      });
      const active = this.active;
      if (active) active.usage = addUsage(active.usage, result.usage);
      if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage ?? 'MCP sampling failed');
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      const share = await this.#ask(owner, `Review the sampled model output before sharing it with MCP server ${this.config.name}. Reply approve or decline:\n${text}`, ['approve', 'decline']);
      if (share.trim().toLowerCase() !== 'approve') throw new Error('User declined sharing MCP sampling output');
      return { model: model.id, role: 'assistant', content: { type: 'text', text }, stopReason: result.stopReason === 'length' ? 'maxTokens' : 'endTurn' };
    });
  }
}

function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function addUsage(total: Usage | undefined, next: Usage): Usage {
  const value = total ?? zeroUsage();
  return {
    input: value.input + next.input, output: value.output + next.output, cacheRead: value.cacheRead + next.cacheRead, cacheWrite: value.cacheWrite + next.cacheWrite,
    totalTokens: value.totalTokens + next.totalTokens,
    cost: { input: value.cost.input + next.cost.input, output: value.cost.output + next.cost.output, cacheRead: value.cost.cacheRead + next.cost.cacheRead, cacheWrite: value.cost.cacheWrite + next.cost.cacheWrite, total: value.cost.total + next.cost.total },
  };
}
