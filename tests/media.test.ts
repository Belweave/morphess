import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_INPUT_LIMITS, validateImageBytes, withImages } from '../src/media/input.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let fixture: string;
let stateDir: string;
let image: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'morphess-images-'));
  stateDir = join(fixture, 'state'); image = join(fixture, 'input.png');
  await writeFile(image, PNG);
});
afterEach(async () => { await rm(fixture, { recursive: true, force: true }); });
describe('explicit image inputs', () => {
  it('retains validated image bytes privately and uses Pi image input', async () => {
    const input = await withImages('Describe this', [image], { stateDir, supportsImages: true });
    expect(input).toEqual([{ type: 'text', text: 'Describe this' }, { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }]);
    const hash = createHash('sha256').update(PNG).digest('hex');
    expect(await readFile(join(stateDir, 'artifacts', hash))).toEqual(PNG);
    if (process.platform !== 'win32') expect((await stat(join(stateDir, 'artifacts', hash))).mode & 0o777).toBe(0o600);
    expect(await withImages('text', [], { stateDir, supportsImages: false })).toBe('text');
  });
  it('rejects forged file extensions, empty files, and raster pixel bombs before retention', async () => {
    await writeFile(image, 'not an image');
    await expect(withImages('', [image], { stateDir, supportsImages: true })).rejects.toThrow('header');
    await expect(stat(stateDir)).rejects.toThrow();
    await writeFile(image, '');
    await expect(withImages('', [image], { stateDir, supportsImages: true })).rejects.toThrow('empty');
    const bomb = Buffer.from(PNG); bomb.writeUInt32BE(100_000, 16);
    expect(() => validateImageBytes(bomb, 'image/png')).toThrow('pixel budget');
    expect(() => validateImageBytes(PNG, 'image/jpeg')).toThrow('header');
  });
  it('bounds per-file and aggregate bytes without full-file allocations', async () => {
    const handle = await open(image, 'r+');
    await handle.truncate(IMAGE_INPUT_LIMITS.maxImageBytes + 1); await handle.close();
    await expect(withImages('', [image], { stateDir, supportsImages: true })).rejects.toThrow('4 MiB');
    const padded = Buffer.alloc(IMAGE_INPUT_LIMITS.maxImageBytes); PNG.copy(padded);
    await writeFile(image, padded);
    await expect(withImages('', [image, image, image, image, image], { stateDir, supportsImages: true })).rejects.toThrow('total input budget');
    await expect(stat(stateDir)).rejects.toThrow();
    await expect(withImages('', Array.from({ length: 17 }, () => image), { stateDir, supportsImages: true })).rejects.toThrow('16 images');
  });
  it.skipIf(process.platform === 'win32')('rejects named pipes without waiting for a writer', async () => {
    const pipe = join(fixture, 'pipe.png'); execFileSync('mkfifo', [pipe]);
    await expect(withImages('', [pipe], { stateDir, supportsImages: true })).rejects.toThrow('regular file');
  });
  it('publishes complete artifacts atomically across concurrent identical attachments', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => withImages('', [image], { stateDir, supportsImages: true })));
    expect(results).toHaveLength(8);
    const artifacts = await readdir(join(stateDir, 'artifacts'));
    expect(artifacts).toHaveLength(1);
    expect(await readFile(join(stateDir, 'artifacts', artifacts[0]!))).toEqual(PNG);
  });
  it('rejects linked artifact directories and invalid existing cache objects', async () => {
    await mkdir(stateDir); const outside = join(fixture, 'outside'); await mkdir(outside);
    await symlink(outside, join(stateDir, 'artifacts'));
    await expect(withImages('', [image], { stateDir, supportsImages: true })).rejects.toThrow('regular directory');
    await rm(join(stateDir, 'artifacts')); await mkdir(join(stateDir, 'artifacts'));
    const hash = createHash('sha256').update(PNG).digest('hex');
    await writeFile(join(stateDir, 'artifacts', hash), Buffer.alloc(PNG.length));
    await expect(withImages('', [image], { stateDir, supportsImages: true })).rejects.toThrow('invalid contents');
  });
});
