import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ThemeName } from './theme.js';

const schema = z.object({
  theme: z.enum(['forest', 'light', 'contrast']).default('forest'),
  sidebar: z.boolean().default(false), thinking: z.boolean().default(false),
  drafts: z.record(z.string().regex(/^\d+$/), z.string().max(64_000)).default({}),
  draftOrder: z.array(z.string().regex(/^\d+$/)).max(6).default([]),
  history: z.array(z.string().max(8_000)).max(30).default([]),
});
export interface TuiPreferences { theme: ThemeName; sidebar: boolean; thinking: boolean; drafts: Record<string, string>; draftOrder?: string[]; history: string[]; }
export const defaultPreferences = (): TuiPreferences => ({ theme: 'forest', sidebar: false, thinking: false, drafts: {}, draftOrder: [], history: [] });

export function rememberDraft(value: TuiPreferences, id: number, text: string): void {
  const key = String(id);
  if (!text) {
    delete value.drafts[key];
    value.draftOrder = (value.draftOrder ?? []).filter(prior => prior !== key);
    return;
  }
  value.drafts[key] = text;
  const recent = value.draftOrder ?? [];
  value.draftOrder = [...Object.keys(value.drafts).filter(prior => !recent.includes(prior)), ...recent]
    .filter(prior => prior !== key).concat(key).slice(-6);
  for (const prior of Object.keys(value.drafts)) if (!value.draftOrder.includes(prior)) delete value.drafts[prior];
}

/** Host-owned, private preferences. No API keys or model payload logs live here. */
export async function readPreferences(stateDir: string): Promise<TuiPreferences> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(join(stateDir, 'ui.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return defaultPreferences();
    const buffer = Buffer.alloc(512 * 1024 + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > 512 * 1024) return defaultPreferences();
    return schema.parse(JSON.parse(buffer.subarray(0, total).toString('utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof z.ZodError || error instanceof SyntaxError) return defaultPreferences();
    throw error;
  } finally { await handle?.close(); }
}

export async function writePreferences(stateDir: string, value: TuiPreferences): Promise<void> {
  const recent = [...new Set(value.draftOrder ?? [])].filter(key => Object.hasOwn(value.drafts, key));
  const order = [...Object.keys(value.drafts).filter(key => !recent.includes(key)), ...recent].slice(-6);
  const parsed = schema.parse({ ...value, draftOrder: order, drafts: Object.fromEntries(order.map(key => [key, value.drafts[key]])) });
  let text = `${JSON.stringify(parsed)}\n`;
  while (Buffer.byteLength(text) > 512 * 1024) {
    if (parsed.history.length) parsed.history.shift();
    else if (parsed.draftOrder.length > 1) delete parsed.drafts[parsed.draftOrder.shift()!];
    else throw new Error('Terminal preferences exceed storage budget');
    text = `${JSON.stringify(parsed)}\n`;
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = join(stateDir, `ui.${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600); created = true;
    try { await file.writeFile(text); } finally { await file.close(); }
    await rename(temporary, join(stateDir, 'ui.json'));
  } finally { if (created) await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}
