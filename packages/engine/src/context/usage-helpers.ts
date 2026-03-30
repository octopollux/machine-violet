import type { UsageStats } from "../agents/agent-loop.js";

/** Accumulate UsageStats into a running total (UsageStats → UsageStats). */
export function accUsage(total: UsageStats, add: UsageStats): void {
  total.inputTokens += add.inputTokens;
  total.outputTokens += add.outputTokens;
  total.cacheReadTokens += add.cacheReadTokens;
  total.cacheCreationTokens += add.cacheCreationTokens;
}
