import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpCredentialStore, createMcpFetch, createMcpOAuthSession, resolveMcpHeaders, type McpCredentialStore, type McpOAuthRegistration, type McpStoredCredentials } from '../src/mcp/auth.js';

type Fetch = typeof globalThis.fetch;
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const temporaryDirectories: string[] = [];
afterEach(async () => { for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'morphess-mcp-auth-'));
  temporaryDirectories.push(directory);
  return directory;
}

function oauthFixture(options: { issuer?: string; cimd?: boolean; tokenError?: boolean; tokenEndpoint?: string; registration?: McpOAuthRegistration; credentialStore?: McpCredentialStore; interactive?: boolean } = {}) {
  const requests: Array<{ url: URL; method: string; body: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
  let authorization: URL | undefined;
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    requests.push({ url, body, method: request.method, authorization: request.headers.get('authorization'), redirect: init?.redirect });
    if (url.origin === 'https://mcp.example' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json({ resource: 'https://mcp.example/mcp', authorization_servers: [options.issuer ?? 'https://auth.example'], scopes_supported: ['tools:read'] });
    }
    if (url.origin === 'https://auth.example' && url.pathname.startsWith('/.well-known/')) {
      return json({
        issuer: options.issuer ?? 'https://auth.example',
        authorization_endpoint: 'https://auth.example/authorize', token_endpoint: options.tokenEndpoint ?? 'https://auth.example/token',
        registration_endpoint: 'https://auth.example/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
        client_id_metadata_document_supported: options.cimd !== false, authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.href === 'https://auth.example/register') {
      return json({ ...JSON.parse(body), client_id: 'dynamically-registered', client_id_issued_at: 1 });
    }
    if (url.href === 'https://auth.example/token') {
      if (options.tokenError) return json({ error: 'invalid_client' }, 400);
      return json({ access_token: 'offline-access', token_type: 'Bearer', refresh_token: 'offline-refresh', expires_in: 3_600 });
    }
    throw new Error(`Unexpected offline OAuth endpoint: ${url.href}`);
  };
  const session = createMcpOAuthSession({
    serverUrl: 'https://mcp.example/mcp', issuer: 'https://auth.example', redirectUrl: 'http://127.0.0.1:9977/callback',
    registration: options.registration ?? { type: 'cimd', clientMetadataUrl: 'https://client.example/morphess.json' },
    onAuthorization: url => { authorization = url; }, fetch,
    credentialStore: options.credentialStore, interactive: options.interactive,
    env: { MCP_TEST_SECRET: 'offline-client-secret' },
  });
  const callback = (): URL => {
    if (!authorization) throw new Error('No authorization URL');
    const result = new URL('http://127.0.0.1:9977/callback');
    result.searchParams.set('code', 'offline-code');
    result.searchParams.set('state', authorization.searchParams.get('state')!);
    result.searchParams.set('iss', 'https://auth.example');
    return result;
  };
  return { session, requests, callback, authorization: () => authorization };
}

describe('MCP credential boundaries', () => {
  it('resolves only environment references and supports dedicated bearer tokens', () => {
    const headers = resolveMcpHeaders({ 'X-Api-Key': 'CUSTOM_KEY' }, { CUSTOM_KEY: 'offline-key', TOKEN: 'offline-token' }, 'TOKEN');
    expect(headers.get('x-api-key')).toBe('offline-key');
    expect(headers.get('authorization')).toBe('Bearer offline-token');
    expect(() => resolveMcpHeaders({ Authorization: 'a literal secret' }, {})).toThrow('references');
    expect(() => resolveMcpHeaders({}, {}, 'MISSING')).toThrow('environment variable MISSING');
    expect(() => resolveMcpHeaders({}, { TOKEN: 'bad\nvalue' }, 'TOKEN')).toThrow('invalid header');
    expect(() => resolveMcpHeaders({}, { TOKEN: 'Bearer token' }, 'TOKEN')).toThrow('invalid characters');
    expect(() => resolveMcpHeaders({ Authorization: 'KEY' }, { KEY: 'key', TOKEN: 'token' }, 'TOKEN')).toThrow('conflicts');
    expect(() => resolveMcpHeaders({ Authorization: 'KEY', authorization: 'KEY' }, { KEY: 'key' })).toThrow('duplicate');
    expect(() => resolveMcpHeaders({ Host: 'KEY' }, { KEY: 'key' })).toThrow('forbidden');
  });

  it('blocks cross-origin requests before forwarding credentials and forces redirect rejection', async () => {
    const requests: Request[] = [];
    const fetch: Fetch = async (input, init) => { requests.push(new Request(input, init)); return json({ ok: true }); };
    const guarded = createMcpFetch('https://mcp.example/mcp', { headers: { authorization: 'Bearer private' }, fetch });
    await guarded(new Request('https://mcp.example/mcp', { headers: { 'X-Request': 'one' } }), { redirect: 'follow', headers: { 'X-Init': 'two' } });
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer private');
    expect(requests[0]!.headers.get('x-request')).toBe('one');
    expect(requests[0]!.headers.get('x-init')).toBe('two');
    expect(requests[0]!.redirect).toBe('error');
    expect(requests[0]!.credentials).toBe('omit');
    await expect(guarded('https://attacker.example/mcp')).rejects.toThrow('outside');
    await expect(guarded('http://mcp.example/mcp')).rejects.toThrow('HTTPS');
    await expect(guarded('https://name:secret@mcp.example/mcp')).rejects.toThrow('embedded');
    expect(requests).toHaveLength(1);
    expect(() => createMcpFetch('http://public.example/mcp')).toThrow('HTTPS');
  });

  it('rejects redirects returned by a custom fetch and allows local HTTP fixtures', async () => {
    let canceled = false;
    const response = new Response(new ReadableStream({ cancel: () => { canceled = true; } }), { status: 302, headers: { location: 'https://attacker.example' } });
    const guarded = createMcpFetch('http://127.0.0.1:9977/mcp', { fetch: async () => response });
    await expect(guarded('http://127.0.0.1:9977/mcp')).rejects.toThrow('redirects are forbidden');
    expect(canceled).toBe(true);
  });
});

describe('issuer-bound manual MCP OAuth', () => {
  it('uses SDK discovery, CIMD, PKCE, issuer validation, resource indicators and refresh offline', async () => {
    const fixture = oauthFixture();
    expect(await fixture.session.authProvider.token()).toBeUndefined();
    expect(await fixture.session.authorize()).toBe('REDIRECT');
    const authorize = fixture.authorization()!;
    expect(authorize.origin).toBe('https://auth.example');
    expect(authorize.searchParams.get('client_id')).toBe('https://client.example/morphess.json');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('resource')).toBe('https://mcp.example/mcp');
    expect(authorize.searchParams.get('scope')).toBe('tools:read');
    expect(authorize.searchParams.get('state')).toHaveLength(43);
    expect(fixture.requests.some(request => request.url.pathname === '/register')).toBe(false);
    await fixture.session.complete(fixture.callback());
    expect(await fixture.session.authProvider.token()).toBe('offline-access');
    const exchange = fixture.requests.find(request => request.url.pathname === '/token')!;
    const body = new URLSearchParams(exchange.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('offline-code');
    expect(body.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);
    expect(body.get('resource')).toBe('https://mcp.example/mcp');
    expect(exchange.authorization).toBeNull();
    expect(await fixture.session.authorize()).toBe('AUTHORIZED');
    const refresh = fixture.requests.filter(request => request.url.pathname === '/token').at(-1)!;
    expect(new URLSearchParams(refresh.body).get('grant_type')).toBe('refresh_token');
    expect(fixture.requests.every(request => request.redirect === 'error')).toBe(true);
    fixture.session.close();
    await expect(fixture.session.authProvider.token()).rejects.toThrow('closed');
    await expect(fixture.session.authorize()).rejects.toThrow('closed');
  });

  it('requires correct state, callback target and issuer before any code exchange', async () => {
    const fixture = oauthFixture();
    await fixture.session.authorize();
    await expect(fixture.session.authorize()).rejects.toThrow('already pending');
    const wrongState = fixture.callback(); wrongState.searchParams.set('state', 'wrong');
    await expect(fixture.session.complete(wrongState)).rejects.toThrow('state');
    const wrongTarget = fixture.callback(); wrongTarget.pathname = '/other';
    await expect(fixture.session.complete(wrongTarget)).rejects.toThrow('redirect URL');
    const duplicate = fixture.callback(); duplicate.searchParams.append('code', 'second');
    await expect(fixture.session.complete(duplicate)).rejects.toThrow('duplicate');
    const wrongIssuer = fixture.callback(); wrongIssuer.searchParams.set('iss', 'https://attacker.example');
    await expect(fixture.session.complete(wrongIssuer)).rejects.toThrow();
    expect(fixture.requests.filter(request => request.url.pathname === '/token')).toHaveLength(0);
    await expect(fixture.session.complete(fixture.callback())).rejects.toThrow('no available pending');
  });

  it('rejects a missing advertised issuer parameter and consumes denied authorizations', async () => {
    const fixture = oauthFixture(); await fixture.session.authorize();
    const missingIssuer = fixture.callback(); missingIssuer.searchParams.delete('iss');
    await expect(fixture.session.complete(missingIssuer)).rejects.toThrow();
    expect(fixture.requests.some(request => request.url.pathname === '/token')).toBe(false);
    await fixture.session.authorize();
    const denied = fixture.callback(); denied.searchParams.delete('code'); denied.searchParams.set('error', 'access_denied');
    await expect(fixture.session.complete(denied)).rejects.toThrow('declined');
    await expect(fixture.session.complete(denied)).rejects.toThrow('no available pending');
  });

  it('permits DCR only when explicitly selected and identifies a native loopback client', async () => {
    const fixture = oauthFixture({ registration: { type: 'dynamic' }, cimd: false });
    await fixture.session.authorize();
    const registration = fixture.requests.find(request => request.url.pathname === '/register')!;
    expect(JSON.parse(registration.body)).toMatchObject({ application_type: 'native', grant_types: ['authorization_code', 'refresh_token'] });
    await fixture.session.complete(fixture.callback());
    expect(await fixture.session.authProvider.token()).toBe('offline-access');
    const noFallback = oauthFixture({ cimd: false });
    await expect(noFallback.session.authorize()).rejects.toThrow('does not support');
    expect(noFallback.requests.some(request => request.url.pathname === '/register')).toBe(false);
  });

  it('binds static client credentials to their issuer and never falls back to DCR', async () => {
    const fixture = oauthFixture({ registration: { type: 'pre-registered', clientId: 'registered', clientSecretEnv: 'MCP_TEST_SECRET' } });
    await fixture.session.authorize(); await fixture.session.complete(fixture.callback());
    const exchange = fixture.requests.find(request => request.url.pathname === '/token')!;
    expect(exchange.authorization).toBe(`Basic ${Buffer.from('registered:offline-client-secret').toString('base64')}`);
    expect(fixture.requests.filter(request => request.url.origin === 'https://mcp.example').every(request => request.authorization === null)).toBe(true);
    const wrongIssuer = oauthFixture({ issuer: 'https://auth.example/other', registration: { type: 'pre-registered', clientId: 'registered', clientSecretEnv: 'MCP_TEST_SECRET' } });
    await expect(wrongIssuer.session.authorize()).rejects.toThrow('configured issuer');
    expect(wrongIssuer.requests.every(request => request.authorization === null)).toBe(true);
    const rejected = oauthFixture({ tokenError: true, registration: { type: 'pre-registered', clientId: 'registered' } });
    await rejected.session.authorize();
    await expect(rejected.session.complete(rejected.callback())).rejects.toThrow('code exchange failed');
    expect(rejected.requests.some(request => request.url.pathname === '/register')).toBe(false);
    expect(rejected.requests.filter(request => request.url.pathname === '/token')).toHaveLength(1);
  });

  it('offers a transport auth provider with explicit manual interaction and resource binding', async () => {
    const fixture = oauthFixture();
    await expect(fixture.session.authProvider.onUnauthorized!({
      serverUrl: new URL('https://mcp.example/other'), response: new Response(null, { status: 401 }), fetchFn: globalThis.fetch,
    })).rejects.toThrow('different resource');
    await expect(fixture.session.authProvider.onUnauthorized!({
      serverUrl: new URL('https://mcp.example/mcp'), response: new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer scope="tools:write"' } }), fetchFn: globalThis.fetch,
    })).rejects.toThrow('host to supply');
    expect(fixture.authorization()!.searchParams.get('scope')).toBe('tools:write');
    await fixture.session.complete(fixture.callback());
    expect(await fixture.session.authProvider.token()).toBe('offline-access');
  });

  it('never sends code or client credentials to endpoints on an unconfigured origin', async () => {
    const fixture = oauthFixture({ tokenEndpoint: 'https://attacker.example/token', registration: { type: 'pre-registered', clientId: 'registered', clientSecretEnv: 'MCP_TEST_SECRET' } });
    await fixture.session.authorize();
    await expect(fixture.session.complete(fixture.callback())).rejects.toThrow('outside');
    expect(fixture.requests.some(request => request.url.origin === 'https://attacker.example')).toBe(false);
    expect(fixture.requests.every(request => request.authorization === null)).toBe(true);
  });

  it('bounds discovery network waits and cancels them when the session closes', async () => {
    let started!: () => void;
    const active = new Promise<void>(resolve => { started = resolve; });
    const fetch: Fetch = async (_input, init) => {
      started();
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const create = (timeoutMs: number) => createMcpOAuthSession({
      serverUrl: 'https://mcp.example/mcp', issuer: 'https://auth.example', redirectUrl: 'http://127.0.0.1/callback',
      registration: { type: 'pre-registered', clientId: 'registered' }, onAuthorization: () => {}, fetch, timeoutMs,
    });
    const closed = create(5_000); const pending = closed.authorize();
    await active; closed.close(); closed.close();
    await expect(pending).rejects.toThrow('closed');
    await expect(create(10).authorize()).rejects.toThrow();
    expect(() => create(0)).toThrow('timeout');
  });

  it('restores reusable credentials after restart and refreshes without interactive registration', async () => {
    const directory = await privateDirectory();
    const credentialStore = await createMcpCredentialStore(join(directory, 'credentials'));
    const fixture = oauthFixture({ credentialStore });
    await fixture.session.authorize();
    const state = fixture.authorization()!.searchParams.get('state')!;
    await fixture.session.complete(fixture.callback());
    fixture.session.close();
    const persisted = await readFile(join(directory, 'credentials', (await readdir(join(directory, 'credentials')))[0]!), 'utf8');
    expect(persisted).toContain('offline-refresh');
    expect(persisted).not.toContain('offline-code');
    expect(persisted).not.toContain(state);
    expect(persisted).not.toContain('verifier');
    expect(persisted).not.toContain('discovery');
    const reopened = oauthFixture({ credentialStore, interactive: false });
    expect(await reopened.session.authProvider.token()).toBe('offline-access');
    expect(reopened.requests).toHaveLength(0);
    await reopened.session.authProvider.onUnauthorized!({ serverUrl: new URL('https://mcp.example/mcp'), response: new Response(null, { status: 401 }), fetchFn: globalThis.fetch });
    expect(reopened.authorization()).toBeUndefined();
    expect(reopened.requests.some(request => request.url.pathname === '/register')).toBe(false);
    const refresh = reopened.requests.find(request => request.url.pathname === '/token')!;
    expect(new URLSearchParams(refresh.body).get('refresh_token')).toBe('offline-refresh');
    expect(await reopened.session.authProvider.token()).toBe('offline-access');
  });

  it('requires explicit login when runtime credentials are missing or rejected, without DCR', async () => {
    const credentialStore = await createMcpCredentialStore(await privateDirectory());
    const missing = oauthFixture({ credentialStore, interactive: false, registration: { type: 'dynamic' } });
    await expect(missing.session.authorize()).rejects.toThrow('morphess mcp login');
    expect(missing.requests).toHaveLength(0);
    const login = oauthFixture({ credentialStore });
    await login.session.authorize(); await login.session.complete(login.callback()); login.session.close();
    const rejected = oauthFixture({ credentialStore, interactive: false, tokenError: true });
    await expect(rejected.session.authorize()).rejects.toThrow('morphess mcp login');
    expect(rejected.requests.some(request => request.url.pathname === '/register')).toBe(false);
    expect(rejected.requests.filter(request => request.url.pathname === '/token')).toHaveLength(1);
    expect(rejected.authorization()).toBeUndefined();
  });

  it('keeps pre-registered client secrets in environment references when saving tokens', async () => {
    const directory = await privateDirectory();
    const credentialStore = await createMcpCredentialStore(directory);
    const fixture = oauthFixture({ credentialStore, registration: { type: 'pre-registered', clientId: 'registered', clientSecretEnv: 'MCP_TEST_SECRET' } });
    await fixture.session.authorize(); await fixture.session.complete(fixture.callback());
    const content = await readFile(join(directory, (await readdir(directory))[0]!), 'utf8');
    expect(content).toContain('offline-access');
    expect(content).not.toContain('offline-client-secret');
    fixture.session.close();
    const reopened = oauthFixture({ credentialStore, interactive: false, registration: { type: 'pre-registered', clientId: 'registered', clientSecretEnv: 'MCP_TEST_SECRET' } });
    await reopened.session.authorize();
    expect(reopened.requests.find(request => request.url.pathname === '/token')!.authorization).toBe(`Basic ${Buffer.from('registered:offline-client-secret').toString('base64')}`);
  });
});

describe('private MCP credential storage', () => {
  const key = { resource: 'https://mcp.example/mcp', issuer: 'https://auth.example' };
  const credentials = (): McpStoredCredentials => ({
    ...key, clientInformation: { issuer: key.issuer, client_id: 'client' },
    tokens: { issuer: key.issuer, token_type: 'Bearer', access_token: 'offline-private', refresh_token: 'refresh' },
  });

  it('creates private files, keeps exact resource/issuer isolation, and atomically replaces entries', async () => {
    const root = await privateDirectory(); const directory = join(root, 'credentials');
    const store = await createMcpCredentialStore(directory);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await store.get(key)).toBeUndefined();
    await Promise.all([store.set(key, credentials()), store.set(key, { ...credentials(), tokenExpiresAt: 1 })]);
    const files = await readdir(directory);
    expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await lstat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
    expect((await store.get(key))?.tokenExpiresAt).toBe(1);
    expect(await store.get({ ...key, issuer: 'https://other.example' })).toBeUndefined();
    expect(await store.get({ ...key, resource: 'https://mcp.example/other' })).toBeUndefined();
    await expect(store.set(key, { ...credentials(), issuer: 'https://other.example' })).rejects.toThrow('resource and issuer');
    await expect(store.set(key, Object.assign(credentials(), { verifier: 'do-not-save' }))).rejects.toThrow('invalid credential');
    await store.delete(key); await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
  });

  it('rejects permissive directories, symlink directories, and permissive credential files', async () => {
    const root = await privateDirectory(); const publicDirectory = join(root, 'public');
    await mkdir(publicDirectory, { mode: 0o755 });
    await expect(createMcpCredentialStore(publicDirectory)).rejects.toThrow('0700');
    const alias = join(root, 'alias'); await symlink(root, alias);
    await expect(createMcpCredentialStore(alias)).rejects.toThrow('without symlinks');
    const store = await createMcpCredentialStore(root); await store.set(key, credentials());
    const file = join(root, (await readdir(root)).find(name => name.endsWith('.json'))!);
    await chmod(file, 0o644);
    await expect(store.get(key)).rejects.toThrow('0600');
    await expect(store.set(key, credentials())).rejects.toThrow('0600');
    await expect(store.delete(key)).rejects.toThrow('0600');
  });

  it('refuses credential symlinks/hardlinks and leaves their targets untouched', async () => {
    const directory = await privateDirectory(); const store = await createMcpCredentialStore(directory);
    await store.set(key, credentials());
    const path = join(directory, (await readdir(directory))[0]!);
    const target = join(directory, 'outside'); await writeFile(target, 'untouched', { mode: 0o600 });
    await unlink(path); await symlink(target, path);
    await expect(store.get(key)).rejects.toThrow('without links');
    await expect(store.set(key, credentials())).rejects.toThrow('without links');
    await expect(store.delete(key)).rejects.toThrow('without links');
    expect(await readFile(target, 'utf8')).toBe('untouched');
    await unlink(path); await link(target, path);
    await expect(store.get(key)).rejects.toThrow('without links');
    expect(await readFile(target, 'utf8')).toBe('untouched');
  });

  it('fails closed on invalid JSON or replaced directories without exposing stored secrets', async () => {
    const root = await privateDirectory(); const directory = join(root, 'credentials');
    const store = await createMcpCredentialStore(directory); await store.set(key, credentials());
    const file = join(directory, (await readdir(directory))[0]!);
    await writeFile(file, 'not json offline-private');
    await expect(store.get(key)).rejects.toThrow('invalid JSON');
    await rename(directory, join(root, 'displaced')); await mkdir(directory, { mode: 0o700 });
    await expect(store.get(key)).rejects.toThrow('identity');
    await expect(store.set(key, credentials())).rejects.toThrow('identity');
    await expect(store.delete(key)).rejects.toThrow('identity');
  });
});
