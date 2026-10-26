import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPreferences, readPreferences, rememberDraft, writePreferences } from '../src/tui/preferences.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'morphess-ui-prefs-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('terminal preference persistence', () => {
  it('restores defaults for missing, malformed, oversized and schema-invalid files', async () => {
    expect(await readPreferences(directory)).toEqual(defaultPreferences());
    for (const text of ['{bad json', JSON.stringify({ theme: 'unknown' }), ' '.repeat(512 * 1024 + 1)]) {
      await writeFile(join(directory, 'ui.json'), text);
      expect(await readPreferences(directory)).toEqual(defaultPreferences());
    }
  });

  it('atomically stores private bounded preferences and restores the active draft', async () => {
    const preferences = { ...defaultPreferences(), theme: 'light' as const, sidebar: true, thinking: true, drafts: { '17': 'Continue this work' }, history: ['Earlier request'] };
    rememberDraft(preferences, 17, 'Continue this work');
    await writePreferences(directory, preferences);
    expect(await readPreferences(directory)).toEqual(preferences);
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') expect((await stat(join(directory, 'ui.json'))).mode & 0o777).toBe(0o600);
    const oversized = { ...preferences, history: Array.from({ length: 31 }, () => 'request') };
    await expect(writePreferences(directory, oversized)).rejects.toThrow();
    expect(await readPreferences(directory)).toEqual(preferences);
  });

  it('limits retained session drafts and leaves a valid file under concurrent saves', async () => {
    const drafts = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [String(index + 1), `Draft ${index + 1}`]));
    await Promise.all([
      writePreferences(directory, { ...defaultPreferences(), drafts }),
      writePreferences(directory, { ...defaultPreferences(), theme: 'contrast', drafts }),
    ]);
    const restored = await readPreferences(directory);
    expect(Object.keys(restored.drafts)).toHaveLength(6);
    expect(restored.drafts['12']).toBe('Draft 12');
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('retains a recently edited old session and prunes oversized Unicode history before its active draft', async () => {
    const preferences = defaultPreferences();
    for (let id = 1; id <= 12; id++) rememberDraft(preferences, id, `Draft ${id}`);
    rememberDraft(preferences, 1, '回'.repeat(64_000));
    for (let id = 20; id <= 30; id++) rememberDraft(preferences, id, '');
    expect(preferences.drafts['1']).toHaveLength(64_000);
    expect(Object.keys(preferences.drafts)).toHaveLength(6);
    preferences.history = Array.from({ length: 30 }, () => '回'.repeat(8_000));
    await writePreferences(directory, preferences);
    const restored = await readPreferences(directory);
    expect(restored.drafts['1']).toBe(preferences.drafts['1']);
    expect(restored.draftOrder?.at(-1)).toBe('1');
    expect(restored.history.length).toBeLessThan(30);
    expect((await stat(join(directory, 'ui.json'))).size).toBeLessThanOrEqual(512 * 1024);
  });

  it.skipIf(process.platform === 'win32')('refuses linked preference files and rejects FIFOs without blocking', async () => {
    const outside = join(directory, 'outside.json');
    await writeFile(outside, JSON.stringify({ theme: 'light' }));
    await symlink(outside, join(directory, 'ui.json'));
    await expect(readPreferences(directory)).rejects.toThrow();
    await writePreferences(directory, defaultPreferences());
    expect(await readFile(outside, 'utf8')).toBe(JSON.stringify({ theme: 'light' }));
    expect(await readPreferences(directory)).toEqual(defaultPreferences());
    await rm(join(directory, 'ui.json')); execFileSync('mkfifo', [join(directory, 'ui.json')]);
    expect(await readPreferences(directory)).toEqual(defaultPreferences());
  });
});
