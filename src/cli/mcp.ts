import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { Command } from 'commander';
import type { MorphessConfig, McpServerConfig } from '../config.js';
import { connectMcpServers } from '../mcp/client.js';
import { createMcpCredentialStore, createMcpOAuthSession } from '../mcp/auth.js';

export interface McpCliOptions {
  config(): Promise<MorphessConfig>;
  /** Bounded host wait; primarily useful for embedding and local fixtures. */
  loginTimeoutMs?: number;
}
type HttpServer = Extract<McpServerConfig, { transport: 'http' }>;
type OAuthServer = HttpServer & { oauth: NonNullable<HttpServer['oauth']> };
type Connection = Awaited<ReturnType<typeof connectMcpServers>>;
const MAX_LOGIN_MS = 5 * 60_000;

function serverNamed(config: MorphessConfig, name: string): McpServerConfig {
  const server = config.mcp.find(item => item.name === name);
  if (!server) throw new Error(`Unknown MCP server: ${name}`);
  return server;
}
function oauthServer(server: McpServerConfig): OAuthServer {
  if (server.transport !== 'http' || !server.oauth) throw new Error('This MCP server has no configured HTTP OAuth client');
  return server as OAuthServer;
}
function keyFor(server: OAuthServer) { return { resource: new URL(server.url).href, issuer: server.oauth.issuer }; }
function loopback(address: string | undefined): boolean { return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'; }
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => { server.close(() => resolve()); });
}
async function withCredentialLock<T>(config: MorphessConfig, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const shutdown = new AbortController();
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(config.stateDir, { retries: 0, stale: 120_000, update: 10_000,
      onCompromised: () => shutdown.abort(new Error('MCP credential writer lock was lost')) });
  } catch { throw new Error('MCP credential operations require exclusive state access. Close the active Morphess host and retry.'); }
  try { const result = await run(shutdown.signal); shutdown.signal.throwIfAborted(); return result; }
  finally { await release().catch(() => { throw new Error('MCP credential writer lock cleanup failed'); }); }
}

/** One explicit, non-replayable OAuth flow. No browser process, model or Pi task is started. */
async function login(server: OAuthServer, config: MorphessConfig, write: (text: string) => void, timeoutMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const redirect = new URL(server.oauth.redirectUrl);
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) ||
      redirect.username || redirect.password || redirect.hash || redirect.search || !redirect.port || redirect.port === '0') {
    throw new Error('MCP CLI login requires a fixed-port HTTP loopback redirect URL without query or fragment');
  }
  const credentialStore = await createMcpCredentialStore(join(config.stateDir, 'mcp-credentials'));
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // Install a rejection observer before network discovery starts.
  void completed.catch(() => {});
  let expectedState: string | undefined;
  let accepting = false;
  let exchanging = false;
  let settled = false;
  const reject = (message: string) => { if (!settled) { settled = true; fail(new Error(message)); } };
  const session = createMcpOAuthSession({
    serverUrl: server.url, ...server.oauth, credentialStore, timeoutMs: Math.min(server.timeoutMs, timeoutMs),
    onAuthorization: url => {
      expectedState = url.searchParams.get('state') ?? undefined;
      accepting = true;
      // The authorization URL is the only interactive URL printed. Callback codes,
      // token responses, secrets and separate state/verifier values are never logged.
      write(`Open this authorization URL in your browser:\n${url.href}\nWaiting for the local callback (up to ${Math.ceil(timeoutMs / 1_000)} seconds).\n`);
    },
  });
  const listener = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const deny = (status: number) => { response.statusCode = status; response.end('Invalid authorization callback.\n'); };
    const hostCount = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === 'host').length;
    if (request.method !== 'GET' || request.headers.origin !== undefined || !loopback(request.socket.remoteAddress) ||
        hostCount !== 1 || request.headers.host?.toLowerCase() !== redirect.host.toLowerCase() ||
        !request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 16_384) { deny(400); return; }
    let callback: URL;
    try { callback = new URL(request.url, redirect.origin); } catch { deny(400); return; }
    if (callback.origin !== redirect.origin || callback.hash) { deny(400); return; }
    if (callback.pathname !== redirect.pathname) { deny(404); return; }
    if (!accepting || exchanging || settled) { deny(409); return; }
    // Reject unsolicited local traffic before consuming the one-shot OAuth flow.
    // The OAuth session performs its own constant-time state check before exchange.
    const state = callback.searchParams.get('state') ?? '';
    if (callback.searchParams.getAll('state').length !== 1 || !expectedState || Buffer.byteLength(state) !== Buffer.byteLength(expectedState) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState)) ||
        ['code', 'iss', 'error'].some(key => callback.searchParams.getAll(key).length > 1)) { deny(400); return; }
    exchanging = true;
    void session.complete(callback).then(() => {
      settled = true; response.once('close', finish); response.end('Authorization complete. You can close this page.\n', finish);
    }, () => {
      response.statusCode = 400; response.end('Authorization failed. Restart MCP login in the terminal.\n');
      reject('MCP authorization failed; restart login. No callback or credential details were logged.');
    });
  });
  listener.maxConnections = 8; listener.maxHeadersCount = 32;
  listener.requestTimeout = 10_000; listener.headersTimeout = 5_000; listener.keepAliveTimeout = 1_000;
  const interrupt = () => { session.close(); reject('MCP login cancelled'); };
  const timer = setTimeout(() => { session.close(); reject('MCP login timed out'); }, timeoutMs);
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    await new Promise<void>((resolve, rejectListen) => {
      listener.once('error', rejectListen);
      listener.listen(Number(redirect.port), redirect.hostname === '[::1]' ? '::1' : '127.0.0.1', () => {
        listener.off('error', rejectListen); resolve();
      });
    });
    listener.on('error', () => reject('MCP callback listener failed'));
    const result = await session.authorize();
    if (result === 'AUTHORIZED') { settled = true; finish(); }
    await completed;
    write(`MCP login saved for ${JSON.stringify(server.name)}.\n`);
  } catch {
    if (settled) await completed;
    throw new Error('MCP login failed. Check the configured issuer, registration and callback listener; no credentials were logged.');
  } finally {
    clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    signal.removeEventListener('abort', interrupt);
    accepting = false; expectedState = undefined; session.close(); await closeServer(listener);
  }
}

async function usingConnection<T>(config: MorphessConfig, server: McpServerConfig, run: (connection: Connection) => Promise<T>): Promise<T> {
  if (server.transport === 'http' && server.oauth) return withCredentialLock(config, signal => openConnection(config, server, run, signal));
  return openConnection(config, server, run);
}
async function openConnection<T>(config: MorphessConfig, server: McpServerConfig, run: (connection: Connection) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const sessions: ReturnType<typeof createMcpOAuthSession>[] = [];
  let connection: Connection | undefined;
  const interrupt = () => { for (const session of sessions) session.close(); void connection?.close().catch(() => {}); };
  signal?.addEventListener('abort', interrupt, { once: true });
  try {
    const authProviders: NonNullable<Parameters<typeof connectMcpServers>[1]>['authProviders'] = {};
    if (server.transport === 'http' && server.oauth) {
      const session = createMcpOAuthSession({ serverUrl: server.url, ...server.oauth, interactive: false,
        credentialStore: await createMcpCredentialStore(join(config.stateDir, 'mcp-credentials')), timeoutMs: server.timeoutMs });
      sessions.push(session);
      (authProviders as Record<string, typeof session.authProvider>)[server.name] = session.authProvider;
    }
    connection = await connectMcpServers([server], { authProviders });
    signal?.throwIfAborted();
    return await run(connection);
  } catch {
    throw new Error(`MCP operation failed for ${server.name}. Check configuration and connectivity; OAuth servers may require morphess mcp login ${server.name}.`);
  } finally {
    signal?.removeEventListener('abort', interrupt);
    try { await connection?.close(); }
    catch { throw new Error('MCP connection cleanup failed'); }
    finally { for (const session of sessions) session.close(); }
  }
}

function jsonObject(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > 1_048_576) throw new Error('MCP JSON input exceeds 1 MiB');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('MCP input must be valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP input must be a JSON object');
  return value as Record<string, unknown>;
}

/** Register one-shot MCP management commands without opening an agent runtime. */
export function registerMcpCommands(program: Command, options: McpCliOptions): void {
  const timeoutMs = options.loginTimeoutMs ?? MAX_LOGIN_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_LOGIN_MS) throw new Error('MCP login timeout must be between 1 and 300000 milliseconds');
  const write = (text: string) => { program.configureOutput().writeOut?.(text); };
  const json = (value: unknown) => write(`${JSON.stringify(value, null, 2)}\n`);
  const mcp = program.command('mcp').description('Manage configured MCP servers, catalogs and OAuth credentials');
  mcp.command('list').description('List configured servers without connecting').action(async () => {
    const config = await options.config();
    json(config.mcp.map(server => ({ name: server.name, transport: server.transport, protocol: server.protocol,
      authentication: server.transport === 'stdio' ? 'process environment' : server.oauth ? 'oauth' : server.bearerTokenEnv ? 'bearer environment' : Object.keys(server.headers).length ? 'header environment' : 'none' })));
  });
  mcp.command('status').argument('[server]').description('Report stored OAuth credential availability without exposing values or connecting').action(async (name?: string) => {
    const config = await options.config(); const servers = name ? [serverNamed(config, name)] : config.mcp;
    const results = [];
    for (const server of servers) {
      if (server.transport !== 'http' || !server.oauth) { results.push({ name: server.name, oauth: false }); continue; }
      const saved = await (await createMcpCredentialStore(join(config.stateDir, 'mcp-credentials'))).get(keyFor(oauthServer(server)));
      results.push({ name: server.name, oauth: true, credentials: Boolean(saved?.tokens),
        accessTokenExpired: saved?.tokens ? saved.tokenExpiresAt !== undefined && saved.tokenExpiresAt <= Date.now() : undefined,
        refreshAvailable: Boolean(saved?.tokens?.refresh_token) });
    }
    json(results);
  });
  const connected = async <T>(name: string, run: (connection: Connection) => Promise<T>) => {
    const config = await options.config(); return usingConnection(config, serverNamed(config, name), run);
  };
  mcp.command('inspect').argument('<server>').description('Connect and report negotiated protocol, capabilities and tool schemas').action(async (name: string) => {
    json(await connected(name, async connection => ({ ...connection.servers[0], tools: connection.extensions.flatMap(extension => (extension.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }))) })));
  });
  mcp.command('resources').argument('<server>').argument('[uri]').description('List resources, or read one explicit URI as inert JSON data').action(async (name: string, uri?: string) => {
    json(await connected<unknown>(name, connection => uri ? connection.readResource(name, uri) : connection.listResources(name)));
  });
  mcp.command('templates').argument('<server>').description('List resource URI templates').action(async (name: string) => {
    json(await connected(name, connection => connection.listResourceTemplates(name)));
  });
  mcp.command('health').argument('<server>').description('Check live discovery or legacy ping without invoking a remote tool').action(async (name: string) => {
    json(await connected(name, connection => connection.health(name)));
  });
  mcp.command('skills').argument('<server>').argument('[uri]').option('--ref <path>', 'read one relative file from the skill')
    .option('--metadata', 'get the skill descriptor').option('--directory', 'read the skill directory')
    .description('List skills or read verified skill content as inert data').action(async (server: string, uri: string | undefined, flags: { ref?: string; metadata?: boolean; directory?: boolean }) => {
      if ((!uri && (flags.ref || flags.metadata || flags.directory)) || [Boolean(flags.ref), Boolean(flags.metadata), Boolean(flags.directory)].filter(Boolean).length > 1) {
        throw new Error('Skill read flags require a URI and --ref, --metadata and --directory are mutually exclusive');
      }
      json(await connected<unknown>(server, connection => !uri ? connection.listSkills(server) : flags.metadata ? connection.getSkill(server, uri)
        : flags.directory ? connection.readSkillDirectory(server, uri) : connection.readSkill(server, uri, flags.ref)));
    });
  mcp.command('call').argument('<server>').argument('<tool>').option('--args <json>', 'explicit tool arguments as a JSON object', '{}')
    .description('Execute an explicit remote tool once; no automatic human approval or durable task creation').action(async (server: string, tool: string, flags: { args: string }) => {
      const args = jsonObject(flags.args);
      json(await connected(server, connection => connection.callTool(server, tool, args)));
    });
  mcp.command('complete').argument('<server>').argument('<type>', 'prompt or resource').argument('<reference>', 'prompt name or resource template URI')
    .argument('<argument>').argument('<value>').description('Request argument completion for a prompt or resource template')
    .action(async (server: string, type: string, reference: string, argument: string, value: string) => {
      if (type !== 'prompt' && type !== 'resource') throw new Error('Completion type must be prompt or resource');
      json(await connected(server, connection => connection.complete(server, {
        ref: type === 'prompt' ? { type: 'ref/prompt', name: reference } : { type: 'ref/resource', uri: reference }, argument: { name: argument, value },
      })));
    });
  const tasks = mcp.command('task').description('Operate on an existing server task ID; requires negotiated Tasks support');
  tasks.command('get').argument('<server>').argument('<id>').description('Get current state of an existing external task').action(async (server: string, id: string) => {
    json(await connected(server, connection => connection.getTask(server, id)));
  });
  tasks.command('cancel').argument('<server>').argument('<id>').description('Explicitly request cooperative cancellation of an existing task').action(async (server: string, id: string) => {
    json(await connected(server, connection => connection.cancelTask(server, id)));
  });
  tasks.command('update').argument('<server>').argument('<id>').requiredOption('--input <json>', 'explicitly approved inputResponses JSON object')
    .description('Send the exact supplied input responses to an existing task').action(async (server: string, id: string, flags: { input: string }) => {
      const responses = jsonObject(flags.input);
      json(await connected(server, connection => connection.updateTask(server, id, responses)));
    });
  mcp.command('prompts').argument('<server>').argument('[name]').option('--arg <key=value>', 'prompt argument (repeatable)', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .description('List prompts, or retrieve one prompt with explicit arguments').action(async (server: string, name: string | undefined, flags: { arg: string[] }) => {
      if (!name && flags.arg.length) throw new Error('Prompt arguments require a prompt name');
      const args: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const argument of flags.arg) {
        const index = argument.indexOf('=');
        if (index < 1 || argument.length > 65_536 || Object.hasOwn(args, argument.slice(0, index)) || flags.arg.length > 64) throw new Error('Use distinct prompt arguments in key=value form (maximum 64)');
        args[argument.slice(0, index)] = argument.slice(index + 1);
      }
      json(await connected<unknown>(server, connection => name ? connection.getPrompt(server, { name, arguments: args }) : connection.listPrompts(server)));
    });
  mcp.command('refresh').argument('<server>').description('Connect and explicitly refresh this server’s current tool catalog').action(async (name: string) => {
    json(await connected(name, async connection => { await connection.refresh(name); return { ...connection.servers[0], tools: connection.extensions.flatMap(extension => (extension.tools ?? []).map(tool => tool.name)) }; }));
  });
  mcp.command('login').argument('<server>').description('Authorize a configured OAuth server using a bounded local callback').action(async (name: string) => {
    const config = await options.config(); const server = oauthServer(serverNamed(config, name));
    await withCredentialLock(config, signal => login(server, config, write, timeoutMs, signal));
  });
  mcp.command('logout').argument('<server>').description('Delete local reusable OAuth credentials (does not revoke tokens at the issuer)').action(async (name: string) => {
    const config = await options.config(); const server = oauthServer(serverNamed(config, name));
    await withCredentialLock(config, async signal => { signal.throwIfAborted(); await (await createMcpCredentialStore(join(config.stateDir, 'mcp-credentials'))).delete(keyFor(server)); });
    write(`Local MCP credentials removed for ${JSON.stringify(server.name)}.\n`);
  });
  mcp.addHelpText('after', '\nExamples:\n  morphess mcp list\n  morphess mcp login source\n  morphess mcp inspect source\n  morphess mcp resources source docs://readme\n  morphess mcp prompts source review --arg path=src/main.ts\n');
  const examples: Record<string, string> = {
    list: 'morphess mcp list\n\nReads configured servers without starting their processes or contacting endpoints.',
    status: 'morphess mcp status\n  morphess mcp status source\n\nReports stored credential availability; does not refresh tokens or test server access.',
    inspect: 'morphess mcp inspect source\n\nReports negotiated protocol, advertised capabilities and prefixed tool schemas.',
    resources: 'morphess mcp resources source\n  morphess mcp resources source docs://readme\n\nAn omitted URI lists resources. An explicit URI is read through this server and printed as inert JSON.',
    templates: "morphess mcp templates source\n\nLists URI templates; use resources with a concrete URI to read content.",
    health: 'morphess mcp health source\n\nUses live discovery on modern servers or ping on legacy servers.',
    skills: "morphess mcp skills source\n  morphess mcp skills source '<uri-from-list>'\n  morphess mcp skills source '<uri-from-list>' --ref references/checklist.md\n  morphess mcp skills source '<uri-from-list>' --metadata\n\nUse a URI returned by the listing. Received instructions remain inert data; nothing is installed or activated.",
    call: 'morphess mcp call source lookup --args \'{"query":"parser"}\'\n\nlookup is the original remote tool name. This executes the operation once and may change remote state. Human input, sampling approval and new durable external tasks require an agent session.',
    complete: "morphess mcp complete source prompt review path src/\n  morphess mcp complete source resource 'docs://{path}' path src/\n\nThe type is prompt or resource; the reference identifies a prompt or resource template.",
    prompts: 'morphess mcp prompts source\n  morphess mcp prompts source review --arg path=src/main.ts --arg language=typescript\n\nArguments are distinct key=value pairs. Returned prompt content remains JSON data.',
    refresh: 'morphess mcp refresh source\n\nRefreshes the connected tool catalog once, prints it, then closes the connection.',
    login: 'morphess mcp login source\n\nConfigure oauth.issuer, oauth.redirectUrl and oauth.registration first. Close the active host, open the printed authorization URL in your browser, and finish within five minutes. Ctrl+C cancels the local wait.',
    logout: 'morphess mcp logout source\n\nClose the active host first. Deletes local credentials for this resource and issuer; does not revoke tokens remotely.',
    task: "morphess mcp task get source external-task-id\n  morphess mcp task cancel source external-task-id\n  morphess mcp task update source external-task-id --input '{\"confirmation\":{\"action\":\"accept\",\"content\":{\"approved\":true}}}'\n\nRequires tasks enabled and negotiated Tasks support. Use the server's external task ID.",
  };
  for (const command of mcp.commands) command.addHelpText('after', `\nExamples:\n  ${examples[command.name()]}\n`);
  tasks.commands.find(command => command.name() === 'get')!.addHelpText('after', '\nExamples:\n  morphess mcp task get source external-task-id\n\nRequests current task state once. Does not start polling or replay the originating operation.\n');
  tasks.commands.find(command => command.name() === 'cancel')!.addHelpText('after', '\nExamples:\n  morphess mcp task cancel source external-task-id\n\nRequests cooperative cancellation once; the server may already have completed the task.\n');
  tasks.commands.find(command => command.name() === 'update')!.addHelpText('after', '\nExamples:\n  morphess mcp task update source external-task-id --input \'{"confirmation":{"action":"accept","content":{"approved":true}}}\'\n\nSubmits exactly this explicitly approved inputResponses object. The server defines its required response shape.\n');
}
