import { createServer, get, type Server } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServer, createMcpHandler, completable } from '@modelcontextprotocol/server';
import lockfile from 'proper-lockfile';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { defaultConfig, mcpServerSchema, type MorphessConfig } from '../src/config.js';
import { registerMcpCommands } from '../src/cli/mcp.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listening(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return address.port;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function configuration(): Promise<MorphessConfig> {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-mcp-cli-'));
  cleanups.push(() => rm(directory, { force: true, recursive: true }));
  const config = defaultConfig(directory); config.stateDir = join(directory, 'state'); return config;
}
function cli(config: MorphessConfig, timeoutMs = 5_000) {
  let output = ''; let authorization!: (url: URL) => void;
  const authorize = new Promise<URL>(resolve => { authorization = resolve; });
  const program = new Command('morphess').exitOverride().configureOutput({ writeOut: value => {
    output += value;
    const match = value.match(/\n(https?:\/\/[^\n]+)\n/); if (match) authorization(new URL(match[1]!));
  }, writeErr: () => {} });
  registerMcpCommands(program, { config: async () => config, loginTimeoutMs: timeoutMs });
  for (const command of program.commands.flatMap(command => [command, ...command.commands])) command.exitOverride();
  return { run: (args: string[]) => program.parseAsync(['mcp', ...args], { from: 'user' }), output: () => output, authorize };
}
async function issuerFixture(config: MorphessConfig) {
  const callbackProbe = createServer(); const callbackPort = await listening(callbackProbe); await close(callbackProbe);
  const exchanges: URLSearchParams[] = [];
  let base = '';
  const server = createServer((request, response) => {
    const path = new URL(request.url!, base).pathname;
    response.setHeader('Content-Type', 'application/json');
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      response.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['tools:read'] }));
    } else if (path.startsWith('/.well-known/')) {
      response.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true }));
    } else if (path === '/token') {
      let body = ''; request.on('data', chunk => { body += String(chunk); }); request.on('end', () => {
        exchanges.push(new URLSearchParams(body)); response.end(JSON.stringify({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', token_type: 'Bearer', expires_in: 3600 }));
      });
    } else { response.statusCode = 404; response.end('{}'); }
  });
  const port = await listening(server); base = `http://127.0.0.1:${port}`;
  cleanups.push(() => close(server));
  const redirect = `http://127.0.0.1:${callbackPort}/oauth/callback`;
  config.mcp = [mcpServerSchema.parse({ name: 'source', transport: 'http', url: `${base}/mcp`, oauth: {
    issuer: base, redirectUrl: redirect, registration: { type: 'pre-registered', clientId: 'fixture-client' },
  } })];
  return { base, redirect, exchanges };
}

describe('MCP management CLI', () => {
  it('lists configuration without starting transports and exposes no credential values', async () => {
    const config = await configuration();
    config.mcp = [mcpServerSchema.parse({ name: 'private', transport: 'stdio', command: '/does/not/exist', env: { SECRET: 'SECRET_ENV' } })];
    const command = cli(config); await command.run(['list']);
    expect(JSON.parse(command.output())).toEqual([{ name: 'private', transport: 'stdio', protocol: 'auto', authentication: 'process environment' }]);
    expect(command.output()).not.toContain('SECRET_ENV'); expect(command.output()).not.toContain('/does/not/exist');
    expect(await readdir(config.workspace)).toEqual([]);
  });

  it('completes local SDK OAuth login, rejects unsolicited callbacks, persists credentials and logs out', async () => {
    const config = await configuration(); const fixture = await issuerFixture(config);
    const command = cli(config); const running = command.run(['login', 'source']);
    const authorization = await command.authorize;
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(fixture.redirect); callback.searchParams.set('state', authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-callback-code'); callback.searchParams.set('iss', fixture.base);
    expect((await fetch(callback, { method: 'POST' })).status).toBe(400);
    expect((await fetch(callback, { headers: { Origin: fixture.base } })).status).toBe(400);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      get(callback, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    expect(wrongHost).toBe(400);
    const malformedTarget = await new Promise<number | undefined>((resolve, reject) => {
      get(fixture.redirect, { path: '/\\[invalid' }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    expect(malformedTarget).toBe(400);
    const wrongRoute = new URL(callback); wrongRoute.pathname = '/other'; expect((await fetch(wrongRoute)).status).toBe(404);
    const wrongState = new URL(callback); wrongState.searchParams.set('state', 'wrong'); expect((await fetch(wrongState)).status).toBe(400);
    const duplicate = new URL(callback); duplicate.searchParams.append('code', 'second'); expect((await fetch(duplicate)).status).toBe(400);
    expect(fixture.exchanges).toHaveLength(0);
    expect((await fetch(callback)).status).toBe(200); await running;
    expect(fixture.exchanges).toHaveLength(1); expect(fixture.exchanges[0]!.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);
    expect(command.output()).toContain('MCP login saved for "source"');
    for (const secret of ['fixture-access-token', 'fixture-refresh-token', 'fixture-callback-code']) expect(command.output()).not.toContain(secret);
    const files = await readdir(join(config.stateDir, 'mcp-credentials'));
    const persisted = await readFile(join(config.stateDir, 'mcp-credentials', files[0]!), 'utf8');
    expect(persisted).toContain('fixture-access-token'); expect(persisted).not.toContain('fixture-callback-code');
    expect(persisted).not.toContain(authorization.searchParams.get('state'));
    const status = cli(config); await status.run(['status', 'source']);
    expect(JSON.parse(status.output())).toEqual([{ name: 'source', oauth: true, credentials: true, accessTokenExpired: false, refreshAvailable: true }]);
    expect(status.output()).not.toContain('fixture-access-token');
    const logout = cli(config); await logout.run(['logout', 'source']);
    expect(await readdir(join(config.stateDir, 'mcp-credentials'))).toEqual([]);
    const rebound = createServer(); await new Promise<void>(resolve => rebound.listen(Number(new URL(fixture.redirect).port), '127.0.0.1', resolve)); await close(rebound);
  });

  it('bounds abandoned login and removes listener and process signal handlers', async () => {
    const config = await configuration(); const fixture = await issuerFixture(config);
    const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const command = cli(config, 150); const running = command.run(['login', 'source']);
    await command.authorize; await expect(running).rejects.toThrow('timed out');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
    await expect(fetch(fixture.redirect)).rejects.toThrow();
    expect(await readdir(join(config.stateDir, 'mcp-credentials'))).toEqual([]);
  });

  it('excludes credential mutations and OAuth refresh while the durable runtime owns state', async () => {
    const config = await configuration(); await issuerFixture(config);
    await mkdir(config.stateDir, { mode: 0o700 });
    const release = await lockfile.lock(config.stateDir, { retries: 0 });
    try {
      await expect(cli(config).run(['login', 'source'])).rejects.toThrow('Close the active Morphess host');
      await expect(cli(config).run(['logout', 'source'])).rejects.toThrow('exclusive state');
      await expect(cli(config).run(['inspect', 'source'])).rejects.toThrow('exclusive state');
      const status = cli(config); await status.run(['status', 'source']);
      expect(JSON.parse(status.output())).toEqual([{ name: 'source', oauth: true, credentials: false, refreshAvailable: false }]);
    } finally { await release(); }
  });

  it('handles a real SIGINT without leaving the callback listener, writer lock or credentials', async () => {
    const config = await configuration(); const fixture = await issuerFixture(config);
    const path = join(config.workspace, 'config.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const module = pathToFileURL(join(process.cwd(), 'src/cli/mcp.ts')).href;
    const source = `import {Command} from 'commander'; import {readFile} from 'node:fs/promises'; import {registerMcpCommands} from ${JSON.stringify(module)};
      const config=JSON.parse(await readFile(process.argv[1],'utf8')); const program=new Command('morphess');
      registerMcpCommands(program,{config:async()=>config});
      try{await program.parseAsync(['mcp','login','source'],{from:'user'});}catch{process.stderr.write('Login interrupted\\n');process.exitCode=1;}`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, path], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } });
    let output = ''; child.stderr.on('data', chunk => { output += String(chunk); });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child OAuth flow did not become ready')), 5_000);
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('Waiting for the local callback')) { clearTimeout(timeout); resolve(); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    await ready; const exited = once(child, 'exit'); child.kill('SIGINT');
    expect((await exited)[0]).toBe(1); expect(output).toContain('Login interrupted');
    expect(output).not.toContain('fixture-access-token'); await expect(fetch(fixture.redirect)).rejects.toThrow();
    expect(await readdir(join(config.stateDir, 'mcp-credentials'))).toEqual([]);
    const release = await lockfile.lock(config.stateDir, { retries: 0 }); await release();
  });

  it('provides concrete operation examples without loading configuration on help', () => {
    let calls = 0; const program = new Command('morphess');
    registerMcpCommands(program, { config: async () => { calls++; throw new Error('Help must not load configuration'); } });
    const mcp = program.commands[0]!;
    for (const command of mcp.commands.flatMap(command => [command, ...command.commands])) {
      let output = ''; command.configureOutput({ writeOut: text => { output += text; } }); command.outputHelp();
      expect(output).toContain('Examples:'); expect(output).toContain('morphess mcp ');
      expect(output).not.toContain('undefined');
    }
    expect(calls).toBe(0);
  });

  it('inspects a local modern server and retrieves resources/prompts without executing returned content', async () => {
    const config = await configuration();
    const { SkillsExtension, memorySkillFiles } = await import('@modelcontextprotocol/server/ext/skills');
    const skills = await SkillsExtension.load(memorySkillFiles({
      'review/SKILL.md': '---\nname: review\ndescription: Review code.\n---\n# Review\nRead the checklist.\n',
      'review/references/checklist.md': 'Check source and tests.\n',
    }));
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'fixture', version: '1' });
      skills.attach(server);
      server.registerTool('lookup', { inputSchema: z.object({ query: z.string() }) }, async ({ query }) => ({ content: [{ type: 'text', text: `Lookup ${query}` }] }));
      server.registerResource('readme', 'docs://readme', {}, async uri => ({ contents: [{ uri: uri.href, text: '\x1b[31mresource text' }] }));
      server.registerPrompt('review', { argsSchema: z.object({ path: completable(z.string(), value => ['src/main.ts', 'src/test.ts'].filter(path => path.startsWith(value))) }) }, ({ path }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Review ${path}` } }] }));
      return server;
    });
    const nodeHandler = toNodeHandler(handler); const server = createServer((request, response) => { void nodeHandler(request, response); });
    const port = await listening(server); cleanups.push(async () => { await handler.close(); await close(server); });
    config.mcp = [mcpServerSchema.parse({ name: 'local', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, protocol: '2026-07-28', timeoutMs: 2000 })];
    const inspect = cli(config); await inspect.run(['inspect', 'local']);
    expect(JSON.parse(inspect.output())).toMatchObject({ name: 'local', protocol: '2026-07-28', era: 'modern', capabilities: { tools: {}, resources: {}, prompts: {} } });
    expect(inspect.output()).toContain('lookup'); expect(inspect.output()).toContain('query');
    const resources = cli(config); await resources.run(['resources', 'local']); expect(resources.output()).toContain('docs://readme');
    const read = cli(config); await read.run(['resources', 'local', 'docs://readme']);
    expect(JSON.parse(read.output()).contents[0].text).toBe('\x1b[31mresource text'); expect(read.output()).not.toContain('\x1b');
    const prompt = cli(config); await prompt.run(['prompts', 'local', 'review', '--arg', 'path=src/main.ts']);
    expect(JSON.parse(prompt.output()).messages[0].content.text).toBe('Review src/main.ts');
    const invalid = cli(config); await expect(invalid.run(['prompts', 'local', 'review', '--arg', 'path=x', '--arg', 'path=y'])).rejects.toThrow('distinct');
    const call = cli(config); await call.run(['call', 'local', 'lookup', '--args', '{"query":"test"}']);
    expect(JSON.parse(call.output()).content[0].text).toBe('Lookup test');
    await expect(cli(config).run(['call', 'local', 'lookup', '--args', '[]'])).rejects.toThrow('JSON object');
    const completion = cli(config); await completion.run(['complete', 'local', 'prompt', 'review', 'path', 'src/m']);
    expect(JSON.parse(completion.output()).completion.values).toEqual(['src/main.ts']);
    const templates = cli(config); await templates.run(['templates', 'local']); expect(JSON.parse(templates.output()).resourceTemplates).toContainEqual({ name: 'io.modelcontextprotocol/skills', uriTemplate: 'skill://{+path}' });
    const refresh = cli(config); await refresh.run(['refresh', 'local']); expect(JSON.parse(refresh.output()).tools.some((name: string) => name.includes('lookup'))).toBe(true);
    await cli(config).run(['health', 'local']);
    await expect(cli(config).run(['task', 'update', 'local', 'task-id', '--input', 'null'])).rejects.toThrow('JSON object');
    await expect(cli(config).run(['task', 'get', 'local', 'task-id'])).rejects.toThrow('MCP operation failed');
    const listing = cli(config); await listing.run(['skills', 'local']); const uri = JSON.parse(listing.output()).skills[0].uri as string;
    const skill = cli(config); await skill.run(['skills', 'local', uri]); expect(JSON.parse(skill.output())).toMatchObject({ verified: true, frontmatter: { name: 'review' } });
    const file = cli(config); await file.run(['skills', 'local', uri, '--ref', 'references/checklist.md']); expect(JSON.parse(file.output()).text).toContain('source and tests');
    await expect(cli(config).run(['skills', 'local', uri, '--ref', '../../outside'])).rejects.toThrow('MCP operation failed');
  });
});
