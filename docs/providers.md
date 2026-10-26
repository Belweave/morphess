# Provider setup

Morphess defaults to Morph's OpenAI-compatible endpoint `https://api.morphllm.com/v1`, model `morph-kimik3`, and environment variable `MORPH_API_KEY`. Morph's [model catalog](https://www.morphllm.com/models) identifies that model as a coding and vision model with a 1M context window. Endpoint availability and access depend on your account. Morphess is independent and unofficial.

Run `morphess configure` for an interactive endpoint/model prompt, or supply nonsecret settings:

```sh
morphess configure --base-url https://api.morphllm.com/v1 --model morph-kimik3
morphess auth login
morphess auth status
```

Use `morphess models` to fetch the configured provider's authenticated `/models` roster. In the TUI, `/model` opens a searchable picker and `/model <id>` reviews a manual ID. Selection applies to the current durable session and persists across restarts. The launch default remains in `morphess.json`; change it with `morphess configure --model <id>`. [Model selection and profile limits](tui.md#models) explains metadata inheritance and switching constraints.

Login accepts a key only through masked terminal input. Bracketed paste is supported; press Enter after pasting. Ctrl-C cancels and restores the terminal. Keys are never accepted as command arguments or saved in `morphess.json`. For unattended use, supply the environment variable named by `model.apiKeyEnv`. That variable takes priority over the saved key.

Change providers whenever needed:

```sh
morphess configure --base-url https://provider.example/v1 --model your-model --api chat-completions --key-env OTHER_PROVIDER_KEY
morphess auth login
```

The endpoint must implement the selected OpenAI-compatible Chat Completions or Responses API. This does not add native Anthropic, Gemini or other vendor protocols. Update context limits, modalities, reasoning, compatibility and prices in your configuration to match the chosen model. `configure` preserves those other settings. Changes apply on the next launch; existing runtimes keep their current model configuration.

`-C <workspace>` and `-c <config-file>` select the configuration to update. Only the endpoint, model, API and key-variable fields requested are changed, using an atomic write. Ambient `MORPHESS_BASE_URL`, `MORPHESS_MODEL`, `MORPHESS_API` and `MORPHESS_API_KEY_ENV` overrides are never copied into the file. Those overrides still affect ordinary launches and auth commands, so clear them when configuring a different saved endpoint.

When `configure --base-url` selects a non-Morph URL, its default key variable becomes `MORPHESS_API_KEY`, preventing automatic forwarding of `MORPH_API_KEY`. An explicit `--key-env` always wins. Previously configured key-variable names remain supported. Saved keys are scoped to the exact canonical URL, including API path, query and trailing slash; they are never selected solely by hostname. Credentials for `/v1` do not apply to `/v2` or `/v1/`.

Saved credentials live in `$XDG_CONFIG_HOME/morphess/credentials` (or `~/.config/morphess/credentials`), outside the project by default. The store uses owned 0700 directories and 0600 regular files, rejects links, and uses bounded nonblocking reads and atomic replacements. This private disk store is not an encrypted OS keychain or a sandbox against another process running as your user. Keep it outside source control. Status and doctor report availability and source, never the key. `morphess auth logout` deletes the current endpoint's saved key; it does not revoke it at the provider or unset environment variables.
