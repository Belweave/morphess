import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { err, FileError, LineScanner, ok, StreamDecoder, type BinaryReader, type ExecutionEnv, type Result, type TextLine, type TextLineReader } from '@earendil-works/pi-durable/env';

export const WORKSPACE_FILE_LIMITS = Object.freeze({
  fullReadBytes: 16 * 1024 * 1024,
  scanBytes: 64 * 1024 * 1024,
  lineBytes: 1024 * 1024,
  positionalReadBytes: 16 * 1024 * 1024,
  collectedLines: 100_000,
});
function aborted(context: Context, path: string): FileError | undefined {
  return context.abortSignal?.aborted ? new FileError('aborted', 'Operation aborted', path) : undefined;
}
export function fileError(error: unknown, path: string): FileError {
  if (error instanceof FileError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const mapped = code === 'ABORT_ERR' ? 'aborted' : code === 'ENOENT' ? 'not_found' : code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : code === 'EISDIR' ? 'is_directory' : code === 'ENOTDIR' ? 'not_directory' : code === 'ELOOP' ? 'invalid' : 'unknown';
  return new FileError(mapped, error instanceof Error ? error.message : String(error), path);
}
function limitError(path: string, kind: string): FileError {
  const mutation = kind === 'File write' || kind === 'Appended file';
  return new FileError('invalid', mutation ? `${kind} exceeds the 16 MiB workspace mutation budget` : `${kind} exceeds the workspace read budget; use a smaller byte range with read_bytes`, path);
}

/** Keep Pi's regular-file reader and line scanner, with explicit work/allocation budgets. */
export async function openBoundedBinaryReader(base: ExecutionEnv, path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
  const opened = await base.openBinaryReader(path, options, context);
  if (!opened.ok) return opened;
  const reader = opened.value;
  return ok({
    info: reader.info.bind(reader), close: reader.close.bind(reader),
    async read(offset, length, ctx) {
      if (length > WORKSPACE_FILE_LIMITS.positionalReadBytes) return err(limitError(path, 'Positional read'));
      return reader.read(offset, length, ctx);
    },
    async scanLines(range, ctx) {
      const metadata = await reader.info(ctx);
      if (!metadata.ok) return metadata;
      if (metadata.value.size > WORKSPACE_FILE_LIMITS.scanBytes) return err(limitError(path, 'Line scan'));
      let scanner: LineScanner;
      try { scanner = new LineScanner(range.startLine, range.endLine); }
      catch { return err(new FileError('invalid', 'Invalid line range', path)); }
      for (let position = 0;;) {
        const cancelled = aborted(ctx, path);
        if (cancelled) return err(cancelled);
        const chunk = await reader.read(position, Math.min(64 * 1024, WORKSPACE_FILE_LIMITS.scanBytes + 1 - position), ctx);
        if (!chunk.ok) return chunk;
        if (!chunk.value.length) return ok(scanner.finish());
        position += chunk.value.length;
        if (position > WORKSPACE_FILE_LIMITS.scanBytes) return err(limitError(path, 'Line scan'));
        scanner.push(chunk.value);
      }
    },
  });
}

export async function readBoundedFile(base: ExecutionEnv, path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
  const opened = await base.openBinaryReader(path, undefined, context);
  if (!opened.ok) return opened;
  try {
    const metadata = await opened.value.info(context);
    if (!metadata.ok) return metadata;
    if (metadata.value.size > WORKSPACE_FILE_LIMITS.fullReadBytes) return err(limitError(path, 'Whole-file read'));
    // One extra byte catches growth between fstat and read; the descriptor keeps
    // the selected file stable even when its path is replaced.
    const bytes = await opened.value.read(0, WORKSPACE_FILE_LIMITS.fullReadBytes + 1, context);
    if (!bytes.ok) return bytes;
    return bytes.value.length > WORKSPACE_FILE_LIMITS.fullReadBytes ? err(limitError(path, 'Whole-file read')) : bytes;
  } finally { await opened.value.close(context); }
}

export async function openBoundedTextLineReader(base: ExecutionEnv, path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
  const opened = await base.openBinaryReader(path, undefined, context);
  if (!opened.ok) return opened;
  const reader = opened.value;
  const decoder = new StreamDecoder();
  let offset = 0;
  let buffered = '';
  let ended = false;
  let closed = false;
  return ok({
    async readLine(ctx): Promise<Result<TextLine | undefined, FileError>> {
      if (closed) return err(new FileError('invalid', 'Text line reader is closed', path));
      const cancelled = aborted(ctx, path);
      if (cancelled) return err(cancelled);
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline >= 0) {
          const text = buffered.slice(0, newline);
          if (Buffer.byteLength(text) > WORKSPACE_FILE_LIMITS.lineBytes) return err(limitError(path, 'Text line'));
          buffered = buffered.slice(newline + 1);
          return ok({ text, terminated: true });
        }
        if (Buffer.byteLength(buffered) > WORKSPACE_FILE_LIMITS.lineBytes) return err(limitError(path, 'Text line'));
        if (ended) {
          if (!buffered) return ok(undefined);
          const text = buffered; buffered = '';
          return ok({ text, terminated: false });
        }
        const bytes = await reader.read(offset, Math.min(64 * 1024, WORKSPACE_FILE_LIMITS.scanBytes + 1 - offset), ctx);
        if (!bytes.ok) return bytes;
        offset += bytes.value.length;
        if (offset > WORKSPACE_FILE_LIMITS.scanBytes) return err(limitError(path, 'Text scan'));
        ended = bytes.value.length === 0;
        buffered += ended ? decoder.decode() : decoder.decode(bytes.value);
      }
    },
    async close(ctx) { closed = true; buffered = ''; await reader.close(ctx); },
  });
}

export async function readBoundedTextLines(base: ExecutionEnv, path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
  if (options?.maxLines !== undefined && (!Number.isSafeInteger(options.maxLines) || options.maxLines < 0)) return err(new FileError('invalid', 'maxLines must be a non-negative safe integer', path));
  if (options?.maxLines === 0) return ok([]);
  const opened = await openBoundedTextLineReader(base, path, context);
  if (!opened.ok) return opened;
  const lines: string[] = [];
  let bytes = 0;
  try {
    while (lines.length < (options?.maxLines ?? Infinity)) {
      const line = await opened.value.readLine(context);
      if (!line.ok) return line;
      if (line.value === undefined) return ok(lines);
      bytes += Buffer.byteLength(line.value.text) + 1;
      if (lines.length >= WORKSPACE_FILE_LIMITS.collectedLines || bytes > WORKSPACE_FILE_LIMITS.fullReadBytes) return err(limitError(path, 'Collected text lines'));
      lines.push(line.value.text);
    }
    return ok(lines);
  } finally { await opened.value.close(context); }
}

/** Nonblocking open + fstat before any mutation: FIFOs/devices never receive tool writes. */
export async function mutateRegularFile(path: string, method: 'writeFile' | 'appendFile' | 'truncateFile' | 'flushFile', value: unknown, context: Context): Promise<Result<void, FileError>> {
  const cancelled = aborted(context, path);
  if (cancelled) return err(cancelled);
  const content = method === 'writeFile' || method === 'appendFile' ? value as string | Uint8Array : undefined;
  if (content !== undefined && Buffer.byteLength(content) > WORKSPACE_FILE_LIMITS.fullReadBytes) return err(limitError(path, 'File write'));
  if (method === 'truncateFile' && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > WORKSPACE_FILE_LIMITS.fullReadBytes)) return err(new FileError('invalid', 'Invalid or over-budget file size', path));
  let handle;
  try {
    if (content !== undefined) await mkdir(dirname(path), { recursive: true });
    const flags = (method === 'flushFile' ? constants.O_RDONLY : constants.O_WRONLY) | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK) | (content === undefined ? 0 : constants.O_CREAT) | (method === 'appendFile' ? constants.O_APPEND : 0);
    handle = await open(path, flags);
    const info = await handle.stat();
    if (!info.isFile()) return err(new FileError(info.isDirectory() ? 'is_directory' : 'invalid', 'Only regular files may be mutated', path));
    if (info.nlink > 1) return err(new FileError('permission_denied', 'Refusing mutation of a multiply linked file; copy it into the workspace first', path));
    const afterOpen = aborted(context, path);
    if (afterOpen) return err(afterOpen);
    if (method === 'appendFile' && info.size + Buffer.byteLength(content!) > WORKSPACE_FILE_LIMITS.fullReadBytes) return err(limitError(path, 'Appended file'));
    if (method === 'writeFile') await handle.truncate(0);
    if (content !== undefined) await handle.writeFile(content, { signal: context.abortSignal });
    else if (method === 'truncateFile') await handle.truncate(value as number);
    else await handle.sync();
    return ok(undefined);
  } catch (error) { return err(fileError(error, path)); }
  finally { await handle?.close(); }
}
