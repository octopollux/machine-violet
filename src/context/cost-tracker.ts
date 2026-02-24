/**
 * Token-count tracking for Claude API usage, organized by model tier.
 *
 * Instead of estimating dollar costs (which are unreliable for new models),
 * we track raw token counts per tier: Large (Opus), Medium (Sonnet), Small (Haiku).
 */
import type { UsageStats } from "../agents/agent-loop.js";
import type { ModelTier } from "../config/models.js";

// --- Types ---

export interface TierTokens {
  input: number;
  output: number;
  cached: number;
}

export interface TokenBreakdown {
  byTier: Record<ModelTier, TierTokens>;
  tokens: UsageStats;
  apiCalls: number;
}

// --- Formatting helpers ---

/**
 * Format a token count compactly: 0→"0", 832→"832", 1500→"1.5k", 150000→"150k", 1200000→"1.2M"
 */
export function formatK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${+k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 10 ? `${Math.round(m)}M` : `${+m.toFixed(1)}M`;
}

// Tier display labels
const TIER_LABELS: Record<ModelTier, string> = { large: "L", medium: "M", small: "S" };

// --- Session token tracker ---

function emptyTier(): TierTokens {
  return { input: 0, output: 0, cached: 0 };
}

/**
 * Tracks cumulative token usage across all model tiers.
 */
export class CostTracker {
  private breakdown: TokenBreakdown = {
    byTier: { large: emptyTier(), medium: emptyTier(), small: emptyTier() },
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    apiCalls: 0,
  };

  /** Record usage from an API call, bucketed by tier. */
  record(usage: UsageStats, tier: ModelTier): void {
    const t = this.breakdown.byTier[tier];
    t.input += usage.inputTokens + usage.outputTokens;
    t.output += usage.outputTokens;
    t.cached += usage.cacheReadTokens;

    this.breakdown.tokens.inputTokens += usage.inputTokens;
    this.breakdown.tokens.outputTokens += usage.outputTokens;
    this.breakdown.tokens.cacheReadTokens += usage.cacheReadTokens;
    this.breakdown.tokens.cacheCreationTokens += usage.cacheCreationTokens;
    this.breakdown.apiCalls++;
  }

  /** Get the current token breakdown (independent copy). */
  getBreakdown(): TokenBreakdown {
    return {
      byTier: {
        large: { ...this.breakdown.byTier.large },
        medium: { ...this.breakdown.byTier.medium },
        small: { ...this.breakdown.byTier.small },
      },
      tokens: { ...this.breakdown.tokens },
      apiCalls: this.breakdown.apiCalls,
    };
  }

  /**
   * Format a compact token summary for display in the Esc menu footer.
   * Example: "L 5.2k/40k | M 2k/15k | S 8k/60k"
   * Tiers with 0 input and 0 cached are omitted.
   */
  formatTokens(): string {
    const parts: string[] = [];
    for (const tier of ["large", "medium", "small"] as ModelTier[]) {
      const t = this.breakdown.byTier[tier];
      if (t.input === 0 && t.cached === 0) continue;
      parts.push(`${TIER_LABELS[tier]} ${formatK(t.input)}/${formatK(t.cached)}`);
    }
    return parts.join(" | ");
  }
}
