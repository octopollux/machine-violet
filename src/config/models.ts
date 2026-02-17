import type { ModelId } from "../agents/agent-loop.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelTier = "large" | "medium" | "small";

export interface ModelConfig {
  large: ModelId;
  medium: ModelId;
  small: ModelId;
}

const DEFAULTS: ModelConfig = {
  large: "claude-opus-4-6",
  medium: "claude-sonnet-4-6",
  small: "claude-haiku-4-5-20251001",
};

const VALID_MODELS = new Set<string>([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
]);

let cached: ModelConfig | null = null;

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
