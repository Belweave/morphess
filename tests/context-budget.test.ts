import type { AssistantMessage } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { createContextSettings, estimateContextBudget } from '../src/context/budget.js';

it('reserves at least configured maximum output and uses native compaction', () => {
  const config = defaultConfig('/tmp/workspace');
  config.context.reserveTokens = 1024;
  const settings = createContextSettings(config);
  expect(settings.compaction?.reserveTokens).toBe(32_768);
  expect(settings.compaction?.enabled).toBe(true);
  expect(settings.stream?.maxRetries).toBe(0);
});

it('anchors estimates in provider usage and includes trailing messages', () => {
  const config = defaultConfig('/tmp/workspace');
  const message: AssistantMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'Done' }], api: 'openai-completions', provider: 'morphess', model: 'test', stopReason: 'stop', timestamp: 2,
    usage: { input: 900_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 900_010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const budget = estimateContextBudget(config, [message, { role: 'user', content: 'next', timestamp: 3 }]);
  expect(budget.basis).toBe('provider-usage-plus-estimate');
  expect(budget.estimatedInputTokens).toBeGreaterThan(900_010);
  expect(budget.approximate).toBe(true);
  expect(budget.shouldCompact).toBe(false);
});

it('reports approximation and compaction threshold without mutating prompt history', () => {
  const config = defaultConfig('/tmp/workspace');
  const messages = [{ role: 'user' as const, content: 'x'.repeat(3_500_000), timestamp: 1 }];
  expect(estimateContextBudget(config, messages)).toMatchObject({ shouldCompact: true, basis: 'estimate', approximate: true });
  expect(messages).toHaveLength(1);
});
