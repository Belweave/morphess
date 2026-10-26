import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { Command } from 'commander';
import { loadConfig, type MorphessConfig } from '../config.js';
import { canonicalProviderEndpoint, deleteProviderCredential, getProviderCredentialStatus, saveProviderCredential } from '../models/credentials.js';

type SecretInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode(mode: boolean): unknown };
/** Raw terminal input only: neither readline echo nor secret-bearing argv/stdin pipes. */
export function readMaskedApiKey(input: SecretInput = stdin, output: Writable = stdout): Promise<string> {
  if (!input.isTTY) return Promise.reject(new Error('API key entry requires an interactive terminal; use an environment variable for automation'));
  return new Promise((accept, reject) => {
    let key = ''; let pending = ''; let paste = false; let pasted = ''; let settled = false;
    const previousRaw = Boolean(input.isRaw); const previousPaused = input.isPaused();
    const done = (error?: Error) => {
      if (settled) return; settled = true;
      input.off('data', data); input.off('end', ended); input.off('error', failed); process.off('SIGINT', interrupted);
      input.setRawMode(previousRaw); if (previousPaused) input.pause();
      output.write('\n');
      if (error) reject(error); else if (!key) reject(new Error('API key cannot be empty')); else accept(key);
    };
    const interrupted = () => done(new Error('API key entry cancelled'));
    const ended = () => done(new Error('Terminal closed before API key entry completed'));
    const failed = () => done(new Error('Unable to read API key from terminal'));
    const data = (chunk: Buffer | string) => {
      pending += chunk.toString();
      while (pending && !settled) {
        if (pending.startsWith('\x1b')) {
          const markers = ['\x1b[200~', '\x1b[201~'];
          if (markers.some(marker => marker.startsWith(pending)) && !markers.includes(pending)) return;
          if (pending.startsWith(markers[0]!)) { paste = true; pasted = ''; pending = pending.slice(6); continue; }
          if (pending.startsWith(markers[1]!)) {
            paste = false; key += pasted.trim(); pasted = ''; pending = pending.slice(6);
            if (Buffer.byteLength(key) > 8192) return done(new Error('API key exceeds size limit'));
            output.write('*'); continue;
          }
          return done(new Error('Unsupported terminal input during API key entry'));
        }
        const character = pending[0]!; pending = pending.slice(1);
        if (character === '\x03') return interrupted();
        if (paste) { pasted += character; if (Buffer.byteLength(pasted) > 8192) return done(new Error('API key exceeds size limit')); continue; }
        if (character === '\r' || character === '\n') return done();
        if (character === '\x7f' || character === '\b') { if (key) { key = key.slice(0, -1); output.write('\b \b'); } continue; }
        if (/[\x00-\x1f\x7f]/u.test(character)) return done(new Error('Unsupported control character in API key'));
        key += character; if (Buffer.byteLength(key) > 8192) return done(new Error('API key exceeds size limit'));
        output.write('*');
      }
    };
    output.write('API key (hidden): ');
    input.setRawMode(true); input.on('data', data); input.once('end', ended); input.once('error', failed); process.on('SIGINT', interrupted); input.resume();
  });
}

export interface ProviderConfiguration { baseUrl?: string; model?: string; api?: 'chat-completions' | 'responses'; keyEnv?: string }
/** Read raw config, never effective environment overlays; only provider fields change. */
export async function writeProviderConfiguration(path: string, options: ProviderConfiguration): Promise<void> {
  const target = resolve(path);
  let raw: Record<string, unknown> = {}; let existing = false;
  try {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) throw new Error('Configuration must be a regular unlinked file under 1 MiB');
      const buffer = Buffer.alloc(1_048_577); let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > 1_048_576) throw new Error('Configuration exceeds size limit');
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
      raw = value as Record<string, unknown>; existing = true;
    } finally { await handle.close(); }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (raw.model !== undefined && (typeof raw.model !== 'object' || raw.model === null || Array.isArray(raw.model))) throw new Error('Configuration model must be a JSON object');
  const model = { ...raw.model as Record<string, unknown> | undefined };
  if (options.baseUrl !== undefined) {
    model.baseUrl = canonicalProviderEndpoint(options.baseUrl);
    if (options.keyEnv === undefined) model.apiKeyEnv = model.baseUrl === canonicalProviderEndpoint('https://api.morphllm.com/v1') ? 'MORPH_API_KEY' : 'MORPHESS_API_KEY';
  }
  if (options.model !== undefined) model.id = options.model;
  if (options.api !== undefined) model.api = options.api;
  if (options.keyEnv !== undefined) model.apiKeyEnv = options.keyEnv;
  raw.model = model;
  // Full validation with defaults, explicitly excluding all ambient model overlays.
  const temp = join(dirname(target), `.morphess-config-${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`); await handle.sync(); await handle.close();
    await loadConfig({ cwd: dirname(target), path: temp, env: {} });
    // Refuse replacing a symlink or special file installed while editing.
    try { const stat = await lstat(target); if (!stat.isFile() || stat.nlink !== 1 || !existing) throw new Error('Configuration target changed during update'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    await rename(temp, target);
  } finally { await handle.close(); await unlink(temp).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }); }
}

export function registerProviderCommands(program: Command, dependencies: { config(): Promise<MorphessConfig> }): void {
  program.command('configure').description('Configure provider endpoint and model; changes apply next launch')
    .option('--base-url <url>', 'OpenAI-compatible API base URL').option('--model <id>', 'provider model identifier')
    .option('--api <api>', 'chat-completions or responses').option('--key-env <name>', 'environment variable name (never the secret)')
    .action(async (options: ProviderConfiguration) => {
      if (!Object.values(options).some(value => value !== undefined)) {
        if (!stdin.isTTY || !stdout.isTTY) throw new Error('Use configure flags outside an interactive terminal');
        const current = await dependencies.config(); const prompt = createInterface({ input: stdin, output: stdout });
        try {
          options.baseUrl = (await prompt.question(`Base URL [${current.model.baseUrl}]: `)).trim() || current.model.baseUrl;
          options.model = (await prompt.question(`Model [${current.model.id}]: `)).trim() || current.model.id;
        } finally { prompt.close(); }
      }
      const globals = program.opts<{ config?: string; workspace?: string }>();
      const path = resolve(globals.workspace ?? process.cwd(), globals.config ?? 'morphess.json');
      await writeProviderConfiguration(path, options); stdout.write('Provider configuration saved. Changes apply on the next launch.\n');
    });
  const auth = program.command('auth').description('Manage the configured provider API key outside project files');
  auth.command('login').description('Enter an API key using masked terminal input').action(async () => {
    const config = await dependencies.config();
    const key = await readMaskedApiKey(); await saveProviderCredential(config.model.baseUrl, key);
    stdout.write('Provider API key saved privately for this exact endpoint. Environment credentials take priority.\n');
  });
  auth.command('status').description('Report credential availability without displaying the key').action(async () => {
    const config = await dependencies.config(); stdout.write(`${JSON.stringify(await getProviderCredentialStatus(config.model))}\n`);
  });
  auth.command('logout').description('Remove this endpoint’s saved local key (does not revoke provider access)').action(async () => {
    const config = await dependencies.config(); await deleteProviderCredential(config.model.baseUrl);
    stdout.write('Saved provider key removed. Environment credentials are unchanged.\n');
  });
}
