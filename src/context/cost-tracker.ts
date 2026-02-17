/**
 * Cost tracking for Claude API usage.
 *
 * Pricing (per million tokens):
 *   Opus:   $15 input, $75 output, cache write $18.75, cache read $1.50
 *   Sonnet: $3 input, $15 output, cache write $3.75, cache read $0.30
 *   Haiku:  $0.80 input, $4 output, cache write $1, cache read $0.08
 *
 * All costs in USD.
 */
import type { UsageStats, ModelId } from "../agents/agent-loop.js";

// --- Pricing tables (per million tokens) ---

interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":             { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-sonnet-4-5-20250929":  { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-haiku-4-5-20251001":   { input: 0.80, output: 4,   cacheWrite: 1.00,  cacheRead: 0.08 },
};

// Fallback to Opus pricing if model unknown
function getPricing(model: string): ModelPricing {
  return PRICING[model] ?? PRICING["claude-opus-4-6"];
}

// --- Cost calculation ---

/**
 * Calculate the cost of a single API call.
 */
export function calculateCost(usage: UsageStats, model: ModelId): number {
  const p = getPricing(model);
  const perM = 1_000_000;

  return (
    (usage.inputTokens * p.input) / perM +
    (usage.outputTokens * p.output) / perM +
    (usage.cacheCreationTokens * p.cacheWrite) / perM +
    (usage.cacheReadTokens * p.cacheRead) / perM
  );
}

// --- Session cost tracker ---

export interface CostBreakdown {
  /** Total session cost in USD */
  totalCost: number;
  /** Cost by model tier */
  byModel: Record<string, number>;
  /** Total tokens by category */
  tokens: UsageStats;
  /** Number of API calls made */
  apiCalls: number;
}

/**
 * Tracks cumulative session costs across all model tiers.
 */
export class CostTracker {
  private breakdown: CostBreakdown = {
    totalCost: 0,
    byModel: {},
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    apiCalls: 0,
  };

  /** Record usage from an API call. */
  record(usage: UsageStats, model: ModelId): void {
    const cost = calculateCost(usage, model);

    this.breakdown.totalCost += cost;
    this.breakdown.byModel[model] = (this.breakdown.byModel[model] ?? 0) + cost;
    this.breakdown.tokens.inputTokens += usage.inputTokens;
    this.breakdown.tokens.outputTokens += usage.outputTokens;
    this.breakdown.tokens.cacheReadTokens += usage.cacheReadTokens;
    this.breakdown.tokens.cacheCreationTokens += usage.cacheCreationTokens;
    this.breakdown.apiCalls++;
  }

  /** Get the current cost breakdown. */
  getBreakdown(): CostBreakdown {
    return { ...this.breakdown, byModel: { ...this.breakdown.byModel }, tokens: { ...this.breakdown.tokens } };
  }

  /** Format cost as a human-readable string. */
  formatCost(): string {
    const c = this.breakdown.totalCost;
    if (c < 0.01) return `$${(c * 100).toFixed(2)}¢`;
    return `$${c.toFixed(4)}`;
  }

  /** Format a terse summary for the modeline. */
  formatTerse(): string {
    const c = this.breakdown.totalCost;
    if (c < 0.01) return `<1¢`;
    if (c < 0.10) return `${(c * 100).toFixed(0)}¢`;
    return `$${c.toFixed(2)}`;
  }
}
