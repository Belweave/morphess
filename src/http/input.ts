import { z } from 'zod';
import type { UserInput } from '@earendil-works/pi-durable';
import { IMAGE_INPUT_LIMITS, validateImageBytes } from '../media/input.js';

const image = z.strictObject({ type: z.literal('image'), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().max(5_592_408).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
export const inputContentSchema = z.union([
  z.string().min(1).max(8_000_000),
  z.array(z.union([z.strictObject({ type: z.literal('text'), text: z.string().max(8_000_000) }), image])).min(1).max(32),
]).superRefine((content, ctx) => {
  if (typeof content === 'string') return;
  let count = 0;
  let total = 0;
  for (const [index, block] of content.entries()) {
    if (block.type !== 'image') continue;
    count++;
    try {
      const bytes = Buffer.from(block.data, 'base64');
      if (bytes.toString('base64') !== block.data) throw new Error('Image input requires canonical base64 encoding');
      validateImageBytes(bytes, block.mimeType);
      total += bytes.length;
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: [index], message: error instanceof Error ? error.message : 'Invalid image input' });
    }
  }
  if (count > IMAGE_INPUT_LIMITS.maxFiles) ctx.addIssue({ code: 'custom', message: 'At most 16 images per input' });
  if (total > IMAGE_INPUT_LIMITS.maxTotalBytes) ctx.addIssue({ code: 'custom', message: 'Images exceed the 16 MiB total input budget' });
});

const openaiContent = z.union([
  z.string().max(8_000_000),
  z.array(z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), text: z.string().max(8_000_000) }),
    z.strictObject({ type: z.literal('image_url'), image_url: z.strictObject({ url: z.string().max(5_592_500), detail: z.enum(['auto', 'low', 'high']).optional() }) }),
  ])).min(1).max(32),
]);

export const chatRequestSchema = z.strictObject({
  model: z.string().min(1),
  messages: z.array(z.strictObject({ role: z.enum(['system', 'developer', 'user', 'assistant']), content: openaiContent })).min(1).max(2_000),
  stream: z.boolean().default(false),
  stream_options: z.strictObject({ include_usage: z.boolean().optional() }).optional(),
  conversation_id: z.union([z.string(), z.number().int().nonnegative()]).optional(),
  user: z.string().max(256).optional(),
});

export function fromOpenAIContent(content: z.infer<typeof openaiContent>): UserInput {
  if (typeof content === 'string') return content;
  return inputContentSchema.parse(content.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text };
    if (block.image_url.detail && block.image_url.detail !== 'auto') throw new Error('Image input detail overrides are not supported by the Pi adapter; use auto');
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(block.image_url.url);
    if (!match) throw new Error('Images require inline PNG/JPEG/WebP/GIF data URLs; remote URLs are not fetched');
    return { type: 'image' as const, mimeType: match[1]!, data: match[2]! };
  }));
}
