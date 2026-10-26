import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import type { UserInput } from '@earendil-works/pi-durable';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export const IMAGE_INPUT_LIMITS = Object.freeze({ maxFiles: 16, maxImageBytes: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxDimension: 16_384, maxPixels: 40_000_000 });

/** Validate container headers/dimensions without allocating a decoded raster. */
function dimensions(bytes: Buffer, mime: string): { width: number; height: number } | undefined {
  if (mime === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === 'image/gif') {
    if (bytes.length < 13 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return undefined;
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mime === 'image/webp') {
    if (bytes.length < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 > bytes.length) return undefined;
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    return undefined;
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    let position = 2;
    while (position + 3 < bytes.length) {
      if (bytes[position] !== 0xff) return undefined;
      while (bytes[position] === 0xff) position++;
      const marker = bytes[position++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) return undefined;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (position + 2 > bytes.length) return undefined;
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) return undefined;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return undefined;
        return { width: bytes.readUInt16BE(position + 5), height: bytes.readUInt16BE(position + 3) };
      }
      position += length;
    }
  }
  return undefined;
}

/** Shared inline/local invariant; validates headers, not a full codec decode. */
export function validateImageBytes(bytes: Uint8Array, mimeType: string): void {
  if (!Object.values(MIME).includes(mimeType)) throw new Error('Unsupported image MIME type');
  if (!bytes.byteLength || bytes.byteLength > IMAGE_INPUT_LIMITS.maxImageBytes) throw new Error('Image must contain at most 4 MiB of nonempty data');
  const size = dimensions(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), mimeType);
  if (!size || size.width < 1 || size.height < 1) throw new Error('Image header is invalid or does not match its file extension or MIME type');
  if (size.width > IMAGE_INPUT_LIMITS.maxDimension || size.height > IMAGE_INPUT_LIMITS.maxDimension || size.width * size.height > IMAGE_INPUT_LIMITS.maxPixels) throw new Error('Image dimensions exceed the input pixel budget');
}

async function readImage(path: string, remaining: number, noFollow = false): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0)));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Image must be a regular file');
    if (info.size > IMAGE_INPUT_LIMITS.maxImageBytes) throw new Error('Image exceeds 4 MiB');
    if (info.size > remaining) throw new Error('Images exceed the 16 MiB total input budget');
    const limit = Math.min(IMAGE_INPUT_LIMITS.maxImageBytes, remaining);
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let total = 0;
    // A growing file may outgrow its initial size. The extra byte detects that
    // race without an unbounded readFile allocation.
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
    }
    if (total !== info.size) throw new Error('Image changed while reading; retry the attachment');
    if (total === 0) throw new Error('Image is empty');
    return bytes.subarray(0, total);
  } finally { await handle.close(); }
}

async function persistImage(directory: string, data: Buffer): Promise<void> {
  const path = join(directory, createHash('sha256').update(data).digest('hex'));
  const temporary = join(directory, `.image-${randomUUID()}`);
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(data); } finally { await handle.close(); }
    try {
      // Publish a complete file atomically without following or replacing an
      // existing cache object. Concurrent identical inputs can share the result.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await lstat(path);
      if (!existing.isFile() || existing.size !== data.length) throw new Error('Image artifact already exists with invalid contents');
      const prior = await readImage(path, IMAGE_INPUT_LIMITS.maxImageBytes, true);
      if (!prior.equals(data)) throw new Error('Image artifact already exists with invalid contents');
    }
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Explicit user attachments are bounded, content addressed, and submitted through Pi's durable transcript. */
export async function withImages(prompt: string, files: string[], options: { stateDir: string; supportsImages: boolean }): Promise<UserInput> {
  if (!files.length) return prompt;
  if (!options.supportsImages) throw new Error('This model profile does not declare image input');
  if (files.length > IMAGE_INPUT_LIMITS.maxFiles) throw new Error('At most 16 images per input');
  const images: Array<{ mimeType: string; bytes: Buffer }> = [];
  let total = 0;
  for (const file of files) {
    const path = resolve(file);
    const mimeType = MIME[extname(path).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported image type: ${extname(path)}. Use PNG, JPEG, GIF, or WebP.`);
    const bytes = await readImage(path, IMAGE_INPUT_LIMITS.maxTotalBytes - total);
    validateImageBytes(bytes, mimeType);
    total += bytes.length;
    images.push({ mimeType, bytes });
  }
  // Validate every selection before retaining any artifact. The private state
  // root may already exist; the artifacts directory itself must not be a link.
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const directory = join(await realpath(options.stateDir), 'artifacts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Image artifacts directory must be a regular directory');
  const content: Exclude<UserInput, string> = [{ type: 'text', text: prompt }];
  for (const image of images) {
    await persistImage(directory, image.bytes);
    content.push({ type: 'image', mimeType: image.mimeType, data: image.bytes.toString('base64') });
  }
  return content;
}
