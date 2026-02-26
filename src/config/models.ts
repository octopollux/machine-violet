import type Anthropic from "@anthropic-ai/sdk";
import type { ModelId } from "../agents/agent-loop.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelTier = "large" | "medium" | "small";

export interface ModelConfig {
  large: ModelId;
  medium: ModelId;
  small: ModelId;
  /**
   * Per-agent thinking configuration.
   * Keys are agent names (e.g. "dm", "ooc", "scene-summarizer").
   * Values: 0 = disabled, >= 1024 = explicit budget, "adaptive" = model decides.
   * The "default" key serves as fallback for unconfigured agents.
   */
  thinking: Record<string, number | "adaptive">;
}

export type ThinkingParam = Anthropic.Messages.ThinkingConfigParam;

export interface ThinkingConfig {
  param: ThinkingParam;
  budgetTokens: number;
}

const DEFAULTS: ModelConfig = {
  large: "claude-opus-4-6",
  medium: "claude-sonnet-4-6",
  small: "claude-haiku-4-5-20251001",
  thinking: { "default": 0, "dev-mode": "adaptive" },
};

const VALID_MODELS = new Set<string>([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
]);

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":             { input: 5,    output: 25,  cacheWrite: 6.25,  cacheRead: 0.50 },
  "claude-sonnet-4-6":           { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-sonnet-4-5-20250929":  { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  "claude-haiku-4-5-20251001":   { input: 1,    output: 5,   cacheWrite: 1.25,  cacheRead: 0.10 },
};

let cached: ModelConfig | null = null;
let cachedPricing: Record<string, ModelPricing> | null = null;

/**
 * Load model config: defaults merged with optional dev-config.json overrides.
 * Reads from cwd. Result is cached after first call.
 * Pass `reset: true` in tests to clear cache.
 */
export function loadModelConfig(opts?: { cwd?: string; reset?: boolean }): ModelConfig {
  if (opts?.reset) cached = null;
  if (cached) return cached;

  const config = { ...DEFAULTS };
  const dir = opts?.cwd ?? process.cwd();

  try {
    const raw = readFileSync(join(dir, "dev-config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const models = parsed?.models;
    if (models && typeof models === "object") {
      for (const tier of ["large", "medium", "small"] as ModelTier[]) {
        if (typeof models[tier] === "string" && VALID_MODELS.has(models[tier])) {
          config[tier] = models[tier] as ModelId;
        }
      }
    }
    const thinking = parsed?.thinking;
    if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
      const map: Record<string, number | "adaptive"> = {};
      for (const [key, val] of Object.entries(thinking)) {
        if (val === "adaptive") {
          map[key] = "adaptive";
        } else if (typeof val === "number" && Number.isInteger(val) && (val === 0 || val >= 1024)) {
          map[key] = val;
        }
        // Skip invalid entries silently
      }
      if (Object.keys(map).length > 0) {
        config.thinking = { ...DEFAULTS.thinking, ...map };
      }
    }
  } catch {
    // No dev-config.json or invalid — use defaults
  }

  cached = config;
  return config;
}

/**
 * Get the resolved model ID for a semantic tier.
 */
export function getModel(tier: ModelTier): ModelId {
  return loadModelConfig()[tier];
}

/**
 * Look up thinking configuration for a named agent.
 * Falls back to the "default" key, then disabled.
 */
export function getThinkingConfig(agentName: string): ThinkingConfig {
  const map = loadModelConfig().thinking;
  const value = map[agentName] ?? map["default"] ?? 0;
  if (value === "adaptive") return { param: { type: "adaptive" }, budgetTokens: 0 };
  if (typeof value === "number" && value >= 1024) return { param: { type: "enabled", budget_tokens: value }, budgetTokens: value };
  return { param: { type: "disabled" }, budgetTokens: 0 };
}

/**
 * Load pricing config: defaults merged with optional dev-config.json overrides.
 * Pricing overrides are keyed by model ID string.
 * Pass `reset: true` in tests to clear cache.
 */
export function loadPricingConfig(opts?: { cwd?: string; reset?: boolean }): Record<string, ModelPricing> {
  if (opts?.reset) cachedPricing = null;
  if (cachedPricing) return cachedPricing;

  const pricing: Record<string, ModelPricing> = { ...DEFAULT_PRICING };
  const dir = opts?.cwd ?? process.cwd();

  try {
    const raw = readFileSync(join(dir, "dev-config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const overrides = parsed?.pricing;
    if (overrides && typeof overrides === "object") {
      for (const [modelId, values] of Object.entries(overrides)) {
        const v = values as Record<string, unknown>;
        if (v && typeof v === "object"
            && typeof v.input === "number"
            && typeof v.output === "number"
            && typeof v.cacheWrite === "number"
            && typeof v.cacheRead === "number") {
          pricing[modelId] = v as unknown as ModelPricing;
        }
      }
    }
  } catch {
    // No dev-config.json or invalid — use defaults
  }

  cachedPricing = pricing;
  return pricing;
}
