import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, basename } from 'node:path';

const MAX_BYTES = 16_384;
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Exact canonical endpoint scope: paths, queries and trailing slashes remain distinct. */
export function canonicalProviderEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Provider URL must be HTTP(S), without credentials or fragments');
  return url.href;
}
export function providerCredentialDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CONFIG_HOME && !isAbsolute(env.XDG_CONFIG_HOME)) throw new Error('XDG_CONFIG_HOME must be an absolute directory');
  return resolve(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'morphess', 'credentials');
}
export function providerCredentialPath(baseUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(providerCredentialDirectory(env), `${createHash('sha256').update(canonicalProviderEndpoint(baseUrl)).digest('hex')}.json`);
}
function checkFile(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > MAX_BYTES) throw new Error('Provider credential file must be an owned private 0600 regular file without links');
}
async function directory(env: NodeJS.ProcessEnv, create: boolean): Promise<string | undefined> {
  const path = providerCredentialDirectory(env);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  let stat: Stats;
  try { stat = await lstat(path); } catch (error) { if (missing(error) && !create) return undefined; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Provider credential directory must be an owned private 0700 directory without symlinks');
  return realpath(path);
}
async function checkDirectory(path: string, initial: Stats): Promise<void> {
  const current = await lstat(path);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino || current.mode !== initial.mode || current.uid !== initial.uid) throw new Error('Provider credential directory changed during access');
}
export async function readProviderCredential(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const endpoint = canonicalProviderEndpoint(baseUrl);
  const dir = await directory(env, false); if (!dir) return undefined;
  const initial = await lstat(dir);
  const path = join(dir, basename(providerCredentialPath(baseUrl, env)));
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return undefined; throw new Error('Unable to safely open provider credentials'); }
  try {
    checkFile(await handle.stat());
    // Bounded reads remain bounded even if another same-user process grows the file.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_BYTES) throw new Error('Provider credential file exceeds size limit');
    await checkDirectory(dir, initial);
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); } catch { throw new Error('Invalid provider credential file'); }
    if (typeof value !== 'object' || value === null || !('endpoint' in value) || value.endpoint !== endpoint || !('apiKey' in value) || typeof value.apiKey !== 'string' || !validKey(value.apiKey)) throw new Error('Provider credentials do not match the exact configured endpoint');
    return value.apiKey;
  } finally { await handle.close(); }
}
function validKey(key: string): boolean { return key.length > 0 && Buffer.byteLength(key) <= 8192 && !/[\x00-\x20\x7f]/u.test(key); }
export async function saveProviderCredential(baseUrl: string, apiKey: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!validKey(apiKey)) throw new Error('API key must contain 1–8192 bytes without whitespace or control characters');
  const endpoint = canonicalProviderEndpoint(baseUrl);
  const dir = (await directory(env, true))!;
  const initial = await lstat(dir);
  const path = join(dir, basename(providerCredentialPath(baseUrl, env)));
  try { checkFile(await lstat(path)); } catch (error) { if (!missing(error)) throw error; }
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify({ endpoint, apiKey })); await handle.sync(); await handle.close();
    await checkDirectory(dir, initial);
    try { checkFile(await lstat(path)); } catch (error) { if (!missing(error)) throw error; }
    await rename(temporary, path);
    const descriptor = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await descriptor.sync(); } finally { await descriptor.close(); }
  } finally { await handle.close(); await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}
export async function deleteProviderCredential(baseUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = await directory(env, false); if (!dir) return;
  const path = join(dir, basename(providerCredentialPath(baseUrl, env)));
  try { checkFile(await lstat(path)); await unlink(path); } catch (error) { if (!missing(error)) throw error; }
}
export async function getProviderCredentialStatus(model: { baseUrl: string; apiKeyEnv: string }, env: NodeJS.ProcessEnv = process.env): Promise<{ authenticated: boolean; source: 'environment' | 'private-store' | 'none' }> {
  const source = env[model.apiKeyEnv] ? 'environment' : await readProviderCredential(model.baseUrl, env) ? 'private-store' : 'none';
  return { authenticated: source !== 'none', source };
}
