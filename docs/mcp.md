# Model Context Protocol

Morphess uses the official TypeScript MCP client 2.4.0 and supports the stable **2026-07-28** protocol alongside negotiated legacy servers. MCP tools run inside Pi Durable. They are deferred native tools, available through tool search, the tool catalog, and code mode. Every external operation is replay unsafe: Morphess never repeats a completed tool effect during recovery.

Configure servers in `morphess.json`, then use `morphess tools --all --schema` to inspect their actual tools. [MCP CLI commands](mcp-cli.md) provide direct inspection, resources, prompts, completion, task controls, and OAuth login.

## Compatibility

The table distinguishes implemented core behavior from optional extensions. “Supported” describes tested client behavior; the remote server must advertise the corresponding capability.

| Capability | 2026-07-28 | Legacy | Behavior and limits |
| --- | --- | --- | --- |
| Discovery and negotiation | Supported | Supported | `server/discover`, stateless HTTP and disposable stdio probing; legacy initialize/session fallback. `protocol` can pin a revision or force legacy. |
| HTTP and stdio | Supported | Supported | Official transports; modern per-request metadata and header routing. HTTP redirects and credential forwarding across origins are rejected. |
| Tools and output schemas | Supported | Supported | Stable hashed names, validated catalog, text/images and structured results. Audio is explicitly omitted from model tool output. |
| Resources and URI templates | Supported | Supported | List/read through the configured server; arbitrary resource URLs are never fetched directly by Morphess. Binary and HTML content stay data. |
| Prompts and argument completion | Supported | Supported | List/get/complete helpers; received prompts do not replace agent instructions automatically. |
| Pagination and cacheable lists | Supported | Supported | Official SDK pagination and private per-client TTL caches; at most 64 pages. Refresh bypasses catalog cache. |
| Catalog changes and resource subscriptions | Supported | Supported | Modern `subscriptions/listen`, legacy resource subscriptions; live tool catalog installation. A subscription is bounded by request time and 32 MiB. No automatic reconnect. |
| Progress and cancellation | Supported | Supported | Native progress details, bounded whole-request deadline. Modern HTTP cancellation closes its request stream; shared-channel/legacy cancellation uses official SDK behavior. Cancellation is cooperative. |
| Form elicitation | Supported via MRTR | Supported via push requests | Real durable `ask_user`, schema validation, explicit decline/cancel; requires an active durable invocation. |
| URL elicitation | Supported via MRTR | Supported where advertised | Explicit human review of a credential-free HTTPS URL; no automatic browser launch or URL fetch. |
| Roots | Supported via MRTR | Supported via push requests | Only explicitly configured file roots are shared. No implicit workspace discovery or root-change notifications. |
| Sampling | Opt-in | Opt-in | Durable budgeted model admission, approval before the billed call and approval of the actual output before sharing. Context inclusion and sampling tool loops are rejected. |
| MCP logging (deprecated) | Supported | Supported | Modern per-request logging level; legacy session level. Bounded notifications reach active tool details or an explicit `onLog` callback; no automatic console logging. |
| Tasks extension | Tool creation/get/update/cancel | Not implemented | Official `io.modelcontextprotocol/tasks` V2 schemas; durable handles retained before native tool completion. No automatic polling or original-operation replay. Task-augmented prompts/resources and 2025 experimental tasks are unsupported. |
| Skills over MCP | Supported | Depends on server extension | Official helper lists metadata and verifies declared file size/digest/manifest; directory reads when advertised. No automatic instruction activation or execution. |
| OAuth | Supported | Supported | Protected-resource/authorization discovery, issuer pinning, PKCE S256, resource indicators, CIMD/pre-registered/dynamic clients, refresh, explicit CLI login/logout. See boundaries below. |
| MCP Apps | Resource data only | Resource data only | UI resource metadata and HTML can be read. No HTML execution, interactive renderer, or Apps UI RPC bridge. |
| Enterprise Managed Auth / DPoP | Not implemented | Not implemented | No enterprise JWT grant, cross-app access broker, DPoP, or OS-keychain integration. |

The 2026 protocol deprecates roots, sampling, MCP logging and several legacy mechanisms; they remain available during its compatibility window. Morphess does not claim implementation of every optional ecosystem extension. See the official [2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28), [release explanation](https://blog.modelcontextprotocol.io/posts/2026-07-28/), and [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview).

## Configuration

```json
{
  "mcp": [
    {
      "name": "workspace",
      "transport": "stdio",
      "command": "workspace-mcp",
      "args": ["--stdio"],
      "cwd": ".",
      "env": { "SERVICE_TOKEN": "WORKSPACE_MCP_TOKEN" },
      "protocol": "auto",
      "roots": ["."],
      "elicitation": true,
      "sampling": false,
      "subscriptions": true,
      "tasks": true,
      "maxInputRounds": 8,
      "timeoutMs": 120000
    },
    {
      "name": "service",
      "transport": "http",
      "url": "https://service.example/mcp",
      "protocol": "2026-07-28",
      "bearerTokenEnv": "SERVICE_MCP_TOKEN"
    }
  ]
}
```

`env`, HTTP `headers`, `bearerTokenEnv`, and `clientSecretEnv` contain **environment variable names**, never literal credentials. Missing variables fail clearly. Stdio children receive the SDK's limited default environment plus explicit configured variables. Running a configured stdio command is an explicit trust decision and uses the host's permissions.

Relative stdio `cwd` and root paths resolve against the configuration file directory. Roots may also be explicit file URIs. A root grants the remote server information about a location; it does not sandbox the remote process.

Defaults: `protocol: "auto"`, `elicitation: true`, `sampling: false`, `roots: []`, `subscriptions: true`, `tasks: true`, `maxInputRounds: 8`, `timeoutMs: 30000`. Timeout covers the complete invocation, including queued work, human input, and MRTR continuations. Choose sufficient time for interactive requests. Sampling requires the runtime's human-question extension; direct one-shot calls cannot approve it.

OAuth replaces static authorization for an HTTP server:

```json
{
  "name": "account",
  "transport": "http",
  "url": "https://service.example/mcp",
  "oauth": {
    "issuer": "https://identity.example",
    "redirectUrl": "http://127.0.0.1:8400/callback",
    "registration": {
      "type": "pre-registered",
      "clientId": "registered-client-id"
    }
  }
}
```

Alternative registrations are `{"type":"cimd","clientMetadataUrl":"https://client.example/oauth.json"}` and `{"type":"dynamic"}`. Dynamic registration occurs only during an explicit login. Confidential pre-registered clients can reference `clientSecretEnv`.

Run `morphess mcp login account`. The runtime subsequently loads or refreshes credentials without opening a browser or registering a client. Tokens and registered client information live in `.morphess/mcp-credentials` under private directory/file permissions; transient authorization codes, state and PKCE verifiers are not persisted. The store is disk encryption dependent and does not replace an OS keychain. Never commit it.

The resource origin and configured issuer origin form the auth network boundary. Metadata/token endpoints on a third origin fail closed. HTTPS is required except loopback HTTP. An explicit issuer mismatch, unsafe redirect, embedded URL credentials, conflicting authorization sources, or missing human callback validation rejects the login. Automatic credential forwarding to another origin is prohibited. See [official authorization requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Native agent tools

Each remote tool has a stable `mcp_…` name derived from server and remote name. Management tools are added only for advertised features:

| Remote management name | Purpose |
| --- | --- |
| `morphess:resources_list`, `morphess:resource_read` | Resource/template metadata and explicit resource reads |
| `morphess:prompts_list`, `morphess:prompt_get` | Prompt metadata and prompt contents |
| `morphess:complete` | Prompt/resource argument completion |
| `morphess:task_get`, `morphess:task_update`, `morphess:task_cancel` | Existing external task controls; update requires approval of the exact input JSON |
| `morphess:skills_list`, `morphess:skill_get`, `morphess:skill_read`, `morphess:skill_directory` | Verified skill data; directory tool requires directory capability |
| `morphess:log_level` | Minimum logging severity |

Management names are hashed through the same naming function and visible in the actual catalog. Remote servers cannot shadow reserved management names. Discovery order is deterministic, preserving prompt-cache stability. Helpers are deferred, replay unsafe, and have 64 KiB/2,000-line model output limits.

## Programmatic client

`connectMcpServers(config.mcp, { stateDir: config.stateDir })` returns `extensions`, `servers`, `close()`, and these methods:

- `refresh(name?)`, `health(name)`, `setLogLevel(name, level)`
- `callTool(name, remoteToolName, args, invocation?)`
- `listResources(name)`, `listResourceTemplates(name)`, `readResource(name, uri, invocation?)`
- `listPrompts(name)`, `getPrompt(name, params, invocation?)`, `complete(name, params)`
- `subscribeResources(name, uris)` returning an independently closable subscription
- `getTask(name, taskId)`, `updateTask(name, taskId, inputResponses)`, `cancelTask(name, taskId)`
- `listSkills(name)`, `getSkill(name, uri)`, `readSkill(name, uri, ref?)`, `readSkillDirectory(name, uri)`

An invocation is `{api, context}` from a native Pi tool. Human requests fail without it. Task-enabled tool calls require it before dispatch so a created handle can be durably retained. Direct task updates represent an explicit host action; the native agent-facing helper adds human approval. Programmatic skill reads return verified byte data; native skill reads present bounded text or base64.

Connection options expose `onExtensionsChanged`, `onResourceUpdated`, `onLog`, `onError`, `env`, `stateDir`, and explicit `authProviders`. Hosts should install updated extensions in their registry. Morphess's runtime does this automatically. Always close clients in `finally`.

## Durability and resource boundaries

MCP operations never become replay safe merely because a server claims idempotence. A crash after external execution but before local completion remains uncertain. Resume does not silently reissue that effect. The modern task handle is committed in a session document before a native tool reports it, but the network-to-commit crash window cannot be eliminated by a client. Inspect the remote service before resolving uncertain work.

Per-server FIFO admission keeps legacy server-initiated input associated with one durable invocation. Human waits release the global ordinary-tool semaphore. MRTR is bounded by configured rounds; no hidden sampling calls bypass runtime admission or cost accounting. Sampling requests and returned text must fit human review limits; oversized requests are rejected.

HTTP bodies/streams and stdio buffers are bounded to 32 MiB. Tool catalogs permit 10,000 entries, 8 MiB total metadata and 256 KiB per input schema. Resource subscriptions permit 64 explicit URIs. These are defensive limits, not a claim that large untrusted content is safe to execute. Resource links, Apps HTML, prompts, and skill files remain untrusted data.

Offline tests use real local HTTP/stdio servers with official SDK fixtures, plus validated Tasks-extension envelopes. Coverage includes modern/legacy negotiation, routing, caching, catalogs, subscriptions, MRTR, explicit human questions, durable task retention, billed sampling, roots, verified skills, OAuth, progress and cancellation.
