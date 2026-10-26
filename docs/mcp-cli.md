# MCP commands

MCP commands use the configured `mcp` servers without opening an agent session or sending an inference request. Set the workspace or configuration with the global `-C` and `-c` options. Structured results are JSON; resource and prompt content remains inert data.

```sh
morphess mcp list
morphess mcp status source
morphess mcp inspect source
morphess mcp health source
morphess mcp refresh source
```

`list` reads configuration and reports server names, transports, protocol preferences and authentication methods. `status [server]` reads local OAuth credential availability, expiration and refresh availability. Neither contacts a server or refreshes credentials. Stored availability does not establish that the issuer will accept the credentials.

`inspect <server>` connects and reports the negotiated protocol, advertised capabilities and installed tool schemas. Names in its tool list are Morphess-prefixed names; `call` accepts the server's original remote tool name. `health` performs modern server discovery or a legacy ping. `refresh` opens a connection and explicitly refreshes that connection's tool catalog; it does not start a persistent watcher or mutate another running host's catalog.

## OAuth setup

Configure OAuth on an HTTP server. Use the issuer's exact issuer identifier and a fixed, available loopback callback port registered for the client.

```json
{
  "mcp": [
    {
      "name": "source",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "issuer": "https://auth.example.com",
        "redirectUrl": "http://127.0.0.1:9977/oauth/callback",
        "registration": {
          "type": "pre-registered",
          "clientId": "your-registered-client-id"
        }
      }
    }
  ]
}
```

Registration selects exactly one strategy:

| Strategy | Configuration |
| --- | --- |
| Existing client | `{"type":"pre-registered","clientId":"...","clientSecretEnv":"MCP_CLIENT_SECRET"}`; omit `clientSecretEnv` for a public client. |
| Client metadata document | `{"type":"cimd","clientMetadataUrl":"https://your-domain.example/morphess-client.json"}`; requires issuer support for CIMD and an HTTPS document URL. |
| Dynamic registration | `{"type":"dynamic"}`; explicitly permits registration at the configured issuer. |

`clientSecretEnv` names an environment variable. Its secret value belongs in the environment. OAuth cannot be combined with a configured bearer token or Authorization header. Transport header values and `bearerTokenEnv` are also environment variable references. See [MCP configuration and protocol behavior](mcp.md) for the complete transport schema.

```sh
morphess mcp login source
morphess mcp status source
morphess mcp inspect source
morphess mcp logout source
```

`login` starts the callback listener before discovery, uses PKCE, and prints the issuer's authorization URL for you to open. It does not launch a browser. Open that URL in your browser and complete the issuer's authorization flow within five minutes. A saved reusable credential can authorize through refresh without requiring another browser interaction.

The CLI accepts HTTP callbacks only at a fixed non-default port on `127.0.0.1`, `localhost`, or `[::1]`, with the exact configured host, port and path. `localhost` binds the IPv4 loopback interface; use `[::1]` for an explicit IPv6 listener. Redirect URLs cannot contain credentials, query strings or fragments. Non-GET requests, requests carrying Origin, wrong Host values, wrong routes, duplicate OAuth parameters and invalid state are rejected. Callback state is validated again by the OAuth session before a code exchange. Interrupting login or reaching its deadline closes the listener and OAuth session.

The authorization URL contains the parameters required by the browser flow. Callback URLs, authorization codes, PKCE verifiers, token responses and client secret values are never printed. One-time state, codes and verifiers remain in memory. Reusable credentials are stored separately from Pi transcripts under `<stateDir>/mcp-credentials`, using a private `0700` directory and `0600` files. These files contain reusable credential values and rely on OS file permissions; they are not an OS keychain or encrypted vault.

OAuth login, logout and connected management commands acquire the same state writer lock as the runtime. Close the active Morphess host before running them. This prevents concurrent refreshes from racing rotating refresh tokens. Metadata-only `status` remains available while a host is open. The runtime reuses or refreshes saved credentials but never begins an interactive login automatically.

`logout` deletes local credentials for the exact configured resource URL and issuer. It does not revoke tokens at the issuer or erase credentials already held by another process. Changing the resource URL or issuer selects a different credential entry.

## Resources, prompts and tools

```sh
# List available resources and templates.
morphess mcp resources source
morphess mcp templates source

# Read one URI through the server; the URI is not fetched directly by Morphess.
morphess mcp resources source docs://readme

# List prompts or retrieve one with explicit string arguments.
morphess mcp prompts source
morphess mcp prompts source review --arg path=src/main.ts --arg language=typescript

# Complete an argument for a prompt or resource template.
morphess mcp complete source prompt review path src/
morphess mcp complete source resource 'docs://{path}' path src/

# Execute the remote tool exactly once with explicit JSON arguments.
morphess mcp call source lookup --args '{"query":"parser"}'
```

Prompt arguments use distinct `key=value` pairs; values may contain `=`. Up to 64 arguments are accepted. Tool arguments must be a JSON object no larger than 1 MiB. Calling a tool explicitly grants that remote operation its configured authority; it may change remote state.

Commands close their connections after producing a result. These direct operations do not create durable Pi tasks, approve server requests for human input, or approve sampling requests. A server operation requiring those interactions must run through a durable agent session with the required capabilities enabled. Direct calls to a task-enabled server that could create an external task require a durable invocation and are refused by this CLI path. Returned HTML, resource links and prompt messages are printed as JSON data, without executing code or replacing agent instructions.

## Skills

For servers advertising the Skills extension, list the catalog and use an exact returned URI:

```sh
morphess mcp skills source
morphess mcp skills source '<uri-from-list>'
morphess mcp skills source '<uri-from-list>' --ref references/checklist.md
morphess mcp skills source '<uri-from-list>' --metadata
morphess mcp skills source '<uri-from-list>' --directory
```

The default read retrieves the skill's manifest content; `--ref` reads one relative file. The official SDK checks the manifest and file digest. `--metadata` retrieves the descriptor and `--directory` retrieves directory data. The read flags require a URI and are mutually exclusive. Received instructions are printed as inert JSON data; these commands do not install skills, activate instructions, execute received files, or write them to the workspace.

## Existing external tasks

These commands require `tasks: true` and negotiated modern Tasks support. Supply the server's external task ID, not a Pi task ID or a Morphess display handle.

```sh
morphess mcp task get source external-task-id
morphess mcp task cancel source external-task-id
morphess mcp task update source external-task-id --input '{"confirmation":{"action":"accept","content":{"approved":true}}}'
```

`get` requests current state once. `cancel` requests cooperative cancellation; the server may already have completed the task. `update` submits the exact explicitly supplied `inputResponses` JSON object once. It does not infer input or approve additional requests. Use the response structure required by that server. These commands do not restart the originating operation, create polling loops, or provide transcript durability for the command itself.

Use `morphess mcp --help` and each subcommand's `--help` for argument syntax. Each network operation is bounded by the configured server timeout; server capabilities and issuer support determine which operations are available.
