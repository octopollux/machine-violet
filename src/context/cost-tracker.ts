/**
 * Token-count tracking for Claude API usage, organized by model tier.
 *
 * Instead of estimating dollar costs (which are unreliable for new models),
 * we track raw token counts per tier: Large (Opus), Medium (Sonnet), Small (Haiku).
 */
import type { UsageStats, ModelTier, TierTokens, TokenBreakdown } from "@machine-violet/shared/types/engine.js";
export type { TierTokens, TokenBreakdown } from "@machine-violet/shared/types/engine.js";

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

// Tier display order: small → medium → large (cheapest first)
const TIER_ORDER: ModelTier[] = ["small", "medium", "large"];

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

  /** Optional callback fired after every record() with the new total token count. */
  onRecord?: (totalTokens: number) => void;

  /** Seed from previously persisted breakdown (e.g. on campaign resume). */
  seed(saved: TokenBreakdown): void {
    for (const tier of TIER_ORDER) {
      const src = saved.byTier[tier];
      if (src) {
        this.breakdown.byTier[tier] = { ...src };
      }
    }
    this.breakdown.tokens = { ...saved.tokens };
    this.breakdown.apiCalls = saved.apiCalls;
  }

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

    this.onRecord?.(this.getTotalTokens());
  }

  /** Total tokens consumed this session (input + output). */
  getTotalTokens(): number {
    return this.breakdown.tokens.inputTokens + this.breakdown.tokens.outputTokens;
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
   * Each tier shows in/out/cached. Order: small | medium | large.
   * Example: "8k/0/60k | 2k/0/15k | 5k/200/40k"
   */
  formatTokens(): string {
    return TIER_ORDER.map((tier) => {
      const t = this.breakdown.byTier[tier];
      const pureInput = t.input - t.output;
      return `${formatK(pureInput)}/${formatK(t.output)}/${formatK(t.cached)}`;
    }).join(" | ");
  }
}
