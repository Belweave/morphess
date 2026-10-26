import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  auth, extractWWWAuthenticateParams,
  type AuthProvider, type AuthResult, type OAuthClientProvider, type OAuthDiscoveryState,
} from '@modelcontextprotocol/client';
import type { McpCredentialStore, McpStoredCredentials } from './credential-store.js';

export { createMcpCredentialStore, type McpCredentialStore, type McpCredentialKey, type McpStoredCredentials } from './credential-store.js';

type HeaderReferences = Record<string, string>;
type Fetch = typeof globalThis.fetch;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const forbiddenHeaders = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'proxy-authorization']);

function secretReference(reference: string, env: NodeJS.ProcessEnv): string {
  if (!environmentName.test(reference)) throw new Error('MCP credentials require environment variable references');
  const value = env[reference];
  if (!value) throw new Error(`MCP requires environment variable ${reference}`);
  if (/[\r\n\0]/.test(value)) throw new Error(`MCP environment variable ${reference} contains invalid header characters`);
  return value;
}

/** Resolve references only in transport memory. Never serialize the resulting headers. */
export function resolveMcpHeaders(references: HeaderReferences, env: NodeJS.ProcessEnv = process.env, bearerTokenEnv?: string): Headers {
  const headers = new Headers();
  for (const [name, reference] of Object.entries(references)) {
    const lower = name.toLowerCase();
    if (forbiddenHeaders.has(lower) || headers.has(name)) throw new Error('MCP contains a forbidden or duplicate HTTP header');
    headers.set(name, secretReference(reference, env));
  }
  if (bearerTokenEnv) {
    if (headers.has('authorization')) throw new Error('MCP bearer authentication conflicts with the Authorization header');
    const token = secretReference(bearerTokenEnv, env);
    if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) throw new Error('MCP bearer token has invalid characters');
    headers.set('authorization', `Bearer ${token}`);
  }
  return headers;
}

function secureUrl(value: string | URL): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('MCP authentication requires HTTPS or a loopback HTTP URL without embedded credentials or fragments');
  }
  return url;
}

function requestUrl(input: Parameters<Fetch>[0]): URL {
  return secureUrl(input instanceof Request ? input.url : input);
}

function guardedFetch(allowedOrigins: ReadonlySet<string>, fetchFn: Fetch): Fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    if (!allowedOrigins.has(url.origin)) throw new Error('MCP blocked a request outside its configured authentication origins');
    const response = await fetchFn(input, { ...init, redirect: 'error', credentials: 'omit' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('MCP authentication redirects are forbidden');
    }
    if (response.url && !allowedOrigins.has(new URL(response.url).origin)) {
      await response.body?.cancel();
      throw new Error('MCP authentication response crossed its configured origins');
    }
    return response;
  };
}

/**
 * Resource-server fetch boundary. Configured credentials never enter discovery/token
 * requests, and no redirect or cross-origin transport request can forward them.
 * This is an origin boundary, not a DNS/SSRF sandbox; configured endpoints are trusted.
 */
export function createMcpFetch(resourceUrl: string | URL, options: { headers?: HeadersInit; fetch?: Fetch } = {}): Fetch {
  const resource = secureUrl(resourceUrl);
  const headers = new Headers(options.headers);
  const fetchFn = guardedFetch(new Set([resource.origin]), options.fetch ?? globalThis.fetch);
  return async (input, init) => {
    const combined = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => combined.set(key, value));
    headers.forEach((value, key) => combined.set(key, value));
    return fetchFn(input, { ...init, headers: combined });
  };
}

export type McpOAuthRegistration =
  | { type: 'cimd'; clientMetadataUrl: string }
  | { type: 'pre-registered'; clientId: string; clientSecretEnv?: string }
  | { type: 'dynamic' };

export interface McpOAuthSessionOptions {
  serverUrl: string | URL;
  /** Exact issuer from the operator's trusted authorization-server configuration. */
  issuer: string;
  redirectUrl: string | URL;
  registration: McpOAuthRegistration;
  /** Explicit host interaction only: no browser launch or callback listener is installed. */
  onAuthorization?(url: URL): void | Promise<void>;
  /** Runtime mode may refresh existing credentials but cannot register or begin login. */
  interactive?: boolean;
  credentialStore?: McpCredentialStore;
  clientName?: string;
  /** Network deadline per discovery/authorization operation; human interaction is host owned. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

/**
 * Per-server OAuth session. Discovery, CIMD/DCR, PKCE, resource
 * indicators and RFC 9207 checks use the official SDK. The host owns displaying
 * authorization URLs and supplying callback URLs; credentials never enter Pi storage.
 * Authorization, registration, refresh and code exchange are replay UNSAFE.
 * Only reusable credentials optionally persist in a separate private store.
 * One-time callback state, codes and verifiers remain in memory. One pending flow.
 */
export function createMcpOAuthSession(options: McpOAuthSessionOptions): {
  authProvider: AuthProvider;
  authorize(input?: { resourceMetadataUrl?: URL; scope?: string }): Promise<AuthResult>;
  complete(callback: string | URL): Promise<void>;
  close(): void;
} {
  const serverUrl = secureUrl(options.serverUrl);
  const issuerUrl = secureUrl(options.issuer);
  if (issuerUrl.search) throw new Error('MCP OAuth issuer must not contain a query');
  const redirect = secureUrl(options.redirectUrl);
  if (redirect.search) throw new Error('MCP OAuth redirect URL must not contain a query');
  if (options.registration.type === 'cimd') {
    const metadataUrl = secureUrl(options.registration.clientMetadataUrl);
    if (metadataUrl.protocol !== 'https:' || metadataUrl.pathname === '/' || metadataUrl.search) {
      throw new Error('MCP CIMD requires an HTTPS document URL');
    }
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('MCP OAuth timeout must be a positive bounded integer');
  const shutdown = new AbortController();
  let operationSignal: AbortSignal | undefined;
  const boundedFetch = guardedFetch(new Set([serverUrl.origin, issuerUrl.origin]), options.fetch ?? globalThis.fetch);
  const fetchFn: Fetch = (input, init) => {
    const signals = [shutdown.signal, operationSignal, init?.signal, input instanceof Request ? input.signal : undefined]
      .filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
    return boundedFetch(input, { ...init, signal: AbortSignal.any(signals) });
  };
  type ClientInformation = NonNullable<Awaited<ReturnType<OAuthClientProvider['clientInformation']>>>;
  type Tokens = NonNullable<Awaited<ReturnType<OAuthClientProvider['tokens']>>>;
  let client: ClientInformation | undefined = options.registration.type === 'pre-registered' ? {
    client_id: options.registration.clientId, issuer: options.issuer,
    ...(options.registration.clientSecretEnv ? { client_secret: secretReference(options.registration.clientSecretEnv, options.env ?? process.env) } : {}),
  } : undefined;
  let tokens: Tokens | undefined;
  let tokenExpiresAt: number | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  let verifier: string | undefined;
  let expectedState: string | undefined;
  let authorizationUrl: URL | undefined;
  let busy = false;
  let exchangingCode = false;
  let closed = false;
  let pendingScope: string | undefined;
  let pendingMetadataUrl: URL | undefined;
  const checkOpen = (): void => { if (closed) throw new Error('MCP OAuth session is closed'); };
  const checkIssuer = (issuer: string | undefined): void => {
    if (issuer !== options.issuer) throw new Error('MCP OAuth authorization server does not match its configured issuer');
  };
  const key = { resource: serverUrl.href, issuer: options.issuer };
  const loginRequired = (): Error => new Error('MCP OAuth login is required. Run morphess mcp login <name>.');
  let loading: Promise<void> | undefined;
  const ensureLoaded = (): Promise<void> => {
    loading ??= (async () => {
      const saved = await options.credentialStore?.get(key);
      checkOpen();
      if (!saved) return;
      if (saved.resource !== key.resource) throw new Error('MCP stored OAuth resource does not match its configured resource');
      checkIssuer(saved.issuer);
      if (saved.clientInformation) checkIssuer(saved.clientInformation.issuer);
      if (saved.tokens) checkIssuer(saved.tokens.issuer);
      const configuredId = options.registration.type === 'pre-registered' ? options.registration.clientId :
        options.registration.type === 'cimd' ? options.registration.clientMetadataUrl : undefined;
      if (configuredId && saved.clientInformation?.client_id !== configuredId) return;
      if (options.registration.type !== 'pre-registered') client = saved.clientInformation;
      tokens = saved.tokens;
      tokenExpiresAt = saved.tokenExpiresAt;
    })();
    return loading;
  };
  const persist = async (): Promise<void> => {
    if (!options.credentialStore) return;
    checkOpen();
    // Keep the accepted disk shape deliberately narrow: never serialize SDK
    // discovery state, callback parameters or arbitrary authorization-server fields.
    const value: McpStoredCredentials = { ...key, tokenExpiresAt };
    if (client) value.clientInformation = {
      issuer: options.issuer, client_id: client.client_id,
      ...(options.registration.type !== 'pre-registered' && client.client_secret !== undefined ? { client_secret: client.client_secret } : {}),
      ...(client.client_id_issued_at !== undefined ? { client_id_issued_at: client.client_id_issued_at } : {}),
      ...(client.client_secret_expires_at !== undefined ? { client_secret_expires_at: client.client_secret_expires_at } : {}),
    };
    if (tokens) value.tokens = {
      issuer: options.issuer, access_token: tokens.access_token, token_type: tokens.token_type,
      ...(tokens.refresh_token !== undefined ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.expires_in !== undefined ? { expires_in: tokens.expires_in } : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
    };
    await options.credentialStore.set(key, value);
    checkOpen();
  };
  const provider: OAuthClientProvider = {
    redirectUrl: redirect,
    ...(options.registration.type === 'cimd' ? { clientMetadataUrl: options.registration.clientMetadataUrl } : {}),
    clientMetadata: {
      client_name: options.clientName ?? 'Morphess', redirect_uris: [redirect.href],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: options.registration.type === 'pre-registered' && options.registration.clientSecretEnv ? 'client_secret_basic' : 'none',
      application_type: redirect.protocol === 'http:' ? 'native' : 'web',
    },
    state: () => { expectedState = randomBytes(32).toString('base64url'); return expectedState; },
    clientInformation: ctx => { checkOpen(); checkIssuer(ctx?.issuer); return client; },
    saveClientInformation: options.registration.type === 'pre-registered' || options.interactive === false ? undefined : async (value, ctx) => {
      checkOpen(); checkIssuer(ctx?.issuer); checkIssuer(value.issuer); client = structuredClone(value); await persist();
    },
    tokens: ctx => { checkOpen(); if (ctx) checkIssuer(ctx.issuer); return tokens; },
    saveTokens: async (value, ctx) => {
      checkOpen(); checkIssuer(ctx?.issuer); checkIssuer(value.issuer); tokens = structuredClone(value);
      tokenExpiresAt = value.expires_in === undefined ? undefined : Date.now() + value.expires_in * 1_000;
      await persist();
    },
    saveCodeVerifier: value => { checkOpen(); verifier = value; },
    codeVerifier: () => { if (!verifier) throw new Error('MCP OAuth has no pending PKCE verifier'); return verifier; },
    redirectToAuthorization: url => {
      if (options.interactive === false) throw loginRequired();
      if (secureUrl(url).origin !== issuerUrl.origin) throw new Error('MCP OAuth authorization URL crossed its configured issuer origin');
      authorizationUrl = new URL(url);
    },
    discoveryState: () => discovery,
    saveDiscoveryState: value => {
      checkOpen();
      checkIssuer(value.authorizationServerMetadata?.issuer);
      if (options.registration.type === 'cimd' && value.authorizationServerMetadata?.client_id_metadata_document_supported !== true) {
        throw new Error('MCP authorization server does not support the configured CIMD registration');
      }
      discovery = structuredClone(value);
    },
    invalidateCredentials: async scope => {
      checkOpen();
      if (options.interactive === false) throw loginRequired();
      // SDK auth() normally retries recoverable failures once. An authorization
      // code is single use; force a new explicit flow rather than redeeming it twice.
      if (exchangingCode) throw new Error('MCP OAuth code exchange failed; begin a new authorization');
      if ((scope === 'all' || scope === 'client') && options.registration.type === 'pre-registered') {
        throw new Error('MCP pre-registered OAuth client credentials were rejected; update the configured credential reference');
      }
      if (scope === 'all' || scope === 'tokens') { tokens = undefined; tokenExpiresAt = undefined; }
      if (scope === 'all' || scope === 'client') client = undefined;
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
      if (scope === 'all' || scope === 'discovery') discovery = undefined;
      await persist();
    },
  };
  const authorize = async (input: { resourceMetadataUrl?: URL; scope?: string } = {}): Promise<AuthResult> => {
    checkOpen();
    await ensureLoaded();
    if (options.interactive === false && (!client || !tokens?.refresh_token)) throw loginRequired();
    if (busy || expectedState) throw new Error('MCP OAuth authorization is already pending');
    busy = true;
    operationSignal = AbortSignal.timeout(timeoutMs);
    pendingScope = input.scope;
    pendingMetadataUrl = input.resourceMetadataUrl;
    try {
      const result = await auth(provider, { serverUrl, fetchFn, ...input });
      checkOpen();
      if (result === 'REDIRECT') {
        if (!authorizationUrl || !expectedState) throw new Error('MCP OAuth SDK did not produce an authorization request');
        if (!options.onAuthorization) throw new Error('MCP OAuth requires an explicit host authorization callback');
        await options.onAuthorization(new URL(authorizationUrl));
      }
      return result;
    } catch (error) {
      expectedState = undefined; verifier = undefined; authorizationUrl = undefined;
      throw error;
    } finally { busy = false; operationSignal = undefined; }
  };
  const complete = async (callback: string | URL): Promise<void> => {
    checkOpen();
    if (busy || !expectedState || !verifier || !discovery) throw new Error('MCP OAuth has no available pending authorization');
    const url = secureUrl(callback);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) throw new Error('MCP OAuth callback URL does not match its redirect URL');
    for (const key of ['state', 'code', 'iss', 'error']) {
      if (url.searchParams.getAll(key).length > 1) throw new Error('MCP OAuth callback contains duplicate parameters');
    }
    const state = url.searchParams.get('state') ?? '';
    if (Buffer.byteLength(state) !== Buffer.byteLength(expectedState) || !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
      throw new Error('MCP OAuth callback state does not match');
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code) {
      expectedState = undefined; verifier = undefined; authorizationUrl = undefined;
      throw new Error('MCP OAuth authorization was declined or returned no code');
    }
    busy = true;
    operationSignal = AbortSignal.timeout(timeoutMs);
    // Consume the state before token exchange. Never retry an authorization code implicitly.
    expectedState = undefined;
    exchangingCode = true;
    try {
      const result = await auth(provider, {
        serverUrl, fetchFn, authorizationCode: code, iss: url.searchParams.get('iss') ?? undefined,
        scope: pendingScope, resourceMetadataUrl: pendingMetadataUrl,
      });
      checkOpen();
      if (result !== 'AUTHORIZED') throw new Error('MCP OAuth code exchange did not authorize the session');
    } finally { busy = false; exchangingCode = false; operationSignal = undefined; verifier = undefined; authorizationUrl = undefined; }
  };
  return {
    authProvider: {
      token: async () => {
        checkOpen(); await ensureLoaded();
        return tokenExpiresAt !== undefined && tokenExpiresAt <= Date.now() ? undefined : tokens?.access_token;
      },
      onUnauthorized: async ctx => {
        checkOpen();
        if (ctx.serverUrl.href !== serverUrl.href) throw new Error('MCP OAuth provider belongs to a different resource server');
        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
        if (await authorize({ resourceMetadataUrl, scope }) !== 'AUTHORIZED') {
          throw new Error('MCP OAuth authorization requires the host to supply the callback URL');
        }
      },
    },
    authorize, complete,
    close: () => { closed = true; shutdown.abort(new Error('MCP OAuth session is closed')); tokens = undefined; client = undefined; verifier = undefined; discovery = undefined; expectedState = undefined; authorizationUrl = undefined; },
  };
}
