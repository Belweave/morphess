import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export interface McpCredentialKey { resource: string; issuer: string }

const clientSchema = z.strictObject({
  issuer: z.string().min(1), client_id: z.string().min(1), client_secret: z.string().optional(),
  client_id_issued_at: z.number().nonnegative().optional(), client_secret_expires_at: z.number().nonnegative().optional(),
});
const tokensSchema = z.strictObject({
  issuer: z.string().min(1), access_token: z.string().min(1), token_type: z.string().min(1),
  expires_in: z.number().nonnegative().optional(), refresh_token: z.string().optional(), scope: z.string().optional(),
});
const credentialsSchema = z.strictObject({
  resource: z.string().min(1), issuer: z.string().min(1),
  clientInformation: clientSchema.optional(), tokens: tokensSchema.optional(),
  tokenExpiresAt: z.number().nonnegative().optional(),
});
export type McpStoredCredentials = z.infer<typeof credentialsSchema>;
export interface McpCredentialStore {
  get(key: McpCredentialKey): Promise<McpStoredCredentials | undefined>;
  set(key: McpCredentialKey, value: McpStoredCredentials): Promise<void>;
  delete(key: McpCredentialKey): Promise<void>;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const maxBytes = 1024 * 1024;

function parseCredentials(value: unknown, key: McpCredentialKey): McpStoredCredentials {
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success) throw new Error('MCP credential store contains invalid credential data');
  const credentials = parsed.data;
  if (credentials.resource !== key.resource || credentials.issuer !== key.issuer ||
      (credentials.clientInformation && credentials.clientInformation.issuer !== key.issuer) ||
      (credentials.tokens && credentials.tokens.issuer !== key.issuer)) {
    throw new Error('MCP stored credentials do not match their resource and issuer');
  }
  return credentials;
}

/**
 * Private, disk-backed OAuth credentials, separate from Pi transcripts/session DBs.
 * Exact resource URL + exact issuer key each entry. Only reusable client/token
 * fields are accepted; codes, verifiers, state and discovery data cannot be saved.
 * Writes use exclusive no-follow temporary files, fsync and atomic rename. Reads
 * reject symlinks, hardlinks, foreign owners and permissive file modes. Directory
 * identity is checked on every operation. This is not a sandbox against another
 * process running as the same OS user. Coordinate refreshes with the runtime lock.
 */
export async function createMcpCredentialStore(stateDir: string): Promise<McpCredentialStore> {
  const requested = resolve(stateDir);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const initial = await lstat(requested);
  if (!initial.isDirectory() || initial.isSymbolicLink() || (initial.mode & 0o777) !== 0o700 ||
      (process.getuid && initial.uid !== process.getuid())) {
    throw new Error('MCP credential directory must be an owned, private 0700 directory without symlinks');
  }
  // Resolve trusted ancestor aliases once, then retain the private directory identity.
  const directory = await realpath(requested);
  const checkDirectory = async (): Promise<void> => {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino ||
        current.uid !== initial.uid || (current.mode & 0o777) !== 0o700) {
      throw new Error('MCP credential directory identity or permissions changed');
    }
  };
  const filePath = (key: McpCredentialKey): string => {
    if (!key.resource || !key.issuer) throw new Error('MCP credentials require a resource and issuer');
    return join(directory, `${createHash('sha256').update(JSON.stringify([key.resource, key.issuer])).digest('hex')}.json`);
  };
  const checkFile = (stat: Stats): void => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== initial.uid ||
        (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes) {
      throw new Error('MCP credential file must be an owned, private 0600 regular file without links');
    }
  };
  const checkExisting = async (path: string): Promise<boolean> => {
    try { checkFile(await lstat(path)); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  };
  // Serialize operations on this instance; atomic replacements also keep readers
  // in other processes from seeing a partially written credential document.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => {});
    return next;
  };
  return {
    get: key => serial(async () => {
      await checkDirectory();
      const path = filePath(key);
      if (!await checkExisting(path)) return undefined;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        checkFile(await handle.stat());
        const content = await handle.readFile({ encoding: 'utf8' });
        if (Buffer.byteLength(content) > maxBytes) throw new Error('MCP credential document exceeds its size limit');
        await checkDirectory();
        let value: unknown;
        try { value = JSON.parse(content); } catch { throw new Error('MCP credential store contains invalid JSON'); }
        return parseCredentials(value, key);
      } finally { await handle.close(); }
    }),
    set: (key, value) => serial(async () => {
      const credentials = parseCredentials(value, key);
      const content = JSON.stringify(credentials);
      if (Buffer.byteLength(content) > maxBytes) throw new Error('MCP credential document exceeds its size limit');
      await checkDirectory();
      const path = filePath(key);
      await checkExisting(path);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        await handle.close();
        await checkDirectory();
        await checkExisting(path);
        await rename(temporary, path);
        const dirHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      } finally {
        await handle.close();
        try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
      }
    }),
    delete: key => serial(async () => {
      await checkDirectory();
      const path = filePath(key);
      if (await checkExisting(path)) await unlink(path);
    }),
  };
}
