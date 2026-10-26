import type { Message, TranscriptContext } from '@earendil-works/pi-ai';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { HarnessSettings } from '@earendil-works/pi-durable';
import type { MorphessConfig } from '../config.js';

/** Native durable compaction owns summary admission, concurrent work, and recovery. */
export function createContextSettings(config: MorphessConfig): Pick<HarnessSettings, 'compaction' | 'stream' | 'retry'> {
  const reserveTokens = Math.max(config.context.reserveTokens, config.model.maxOutputTokens);
  if (reserveTokens + config.context.keepRecentTokens >= config.model.contextWindow) {
    throw new Error('Output reserve plus recent history must fit inside the configured context window');
  }
  return {
    compaction: {
      enabled: true, reserveTokens, keepRecentTokens: config.context.keepRecentTokens,
      backgroundTokens: Math.min(config.context.keepRecentTokens, Math.floor((config.model.contextWindow - reserveTokens - config.context.keepRecentTokens) / 4)),
    },
    stream: { timeoutMs: config.model.timeoutMs, maxRetries: config.model.maxRetries, cacheRetention: config.context.cacheRetention },
    // Avoid multiplying provider retries by a second retry loop. Pi persists these attempt boundaries.
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000, maxAgentDelayMs: 60_000 },
  };
}

export interface ContextBudget {
  contextWindow: number;
  estimatedInputTokens: number;
  reserveTokens: number;
  remainingInputTokens: number;
  shouldCompact: boolean;
  basis: 'provider-usage-plus-estimate' | 'estimate';
  /** Estimation is advisory: images and tokenizer-specific encodings vary. */
  approximate: true;
}

/** Reuse Pi's usage-anchored estimate; never claim a heuristic is an exact model tokenizer. */
export function estimateContextBudget(config: MorphessConfig, context: TranscriptContext | readonly Message[]): ContextBudget {
  const estimate = estimateContextTokens(context);
  const reserveTokens = Math.max(config.context.reserveTokens, config.model.maxOutputTokens);
  const remainingInputTokens = config.model.contextWindow - reserveTokens - estimate.tokens;
  return {
    contextWindow: config.model.contextWindow, estimatedInputTokens: estimate.tokens,
    reserveTokens, remainingInputTokens, shouldCompact: remainingInputTokens <= 0,
    basis: estimate.lastUsageIndex === null ? 'estimate' : 'provider-usage-plus-estimate', approximate: true,
  };
}
