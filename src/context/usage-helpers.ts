import type Anthropic from "@anthropic-ai/sdk";
import type { UsageStats } from "../agents/agent-loop.js";

/** Accumulate UsageStats into a running total (UsageStats → UsageStats). */
export function accUsage(total: UsageStats, add: UsageStats): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.cacheReadTokens += add.cacheReadTokens;
  total.cacheCreationTokens += add.cacheCreationTokens;
}

/** Accumulate raw Anthropic.Usage into a running UsageStats total, with cache null-coalescing. */
export function accumulateUsage(total: UsageStats, usage: Anthropic.Usage): void {
  total.inputTokens += usage.input_tokens;
  total.outputTokens += usage.output_tokens;
  const u = usage as Record<string, number>;
  total.cacheReadTokens += u["cache_read_input_tokens"] ?? 0;
  total.cacheCreationTokens += u["cache_creation_input_tokens"] ?? 0;
}
