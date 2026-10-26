import { createHash } from 'node:crypto';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { UserInput } from '@earendil-works/pi-durable';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Explicit user attachments are content addressed on disk; Pi retains the submitted image in the durable transcript. */
export async function withImages(prompt: string, files: string[], options: { stateDir: string; supportsImages: boolean }): Promise<UserInput> {
  if (!files.length) return prompt;
  if (!options.supportsImages) throw new Error('This model profile does not declare image input');
  if (files.length > 16) throw new Error('At most 16 images per input');
  const content: Exclude<UserInput, string> = [{ type: 'text', text: prompt }];
  const directory = join(options.stateDir, 'artifacts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const path = resolve(file);
    const mimeType = MIME[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported image type: ${extname(path)}. Use PNG, JPEG, GIF, or WebP.`);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_IMAGE_BYTES) throw new Error('Image must be a regular file of at most 4 MiB');
    const buffer = await readFile(path);
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('Image exceeds 4 MiB');
    const hash = createHash('sha256').update(buffer).digest('hex');
    await writeFile(join(directory, hash), buffer, { flag: 'wx', mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    content.push({ type: 'image', mimeType, data: buffer.toString('base64') });
  }
  return content;
}
