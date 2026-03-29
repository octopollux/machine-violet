/**
 * Model registry — loads known models from shipped JSON + user overrides.
 *
 * The shipped `known-models.json` defines all supported models with their
 * context windows, pricing, capabilities, and default tier assignments.
 * Users can override or add models via `{configDir}/model-overrides.json`.
 *
 * This replaces the hardcoded model lists in models.ts.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnownModelEntry {
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  defaultTier: "large" | "medium" | "small";
  compactionThreshold: number;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
}

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache write tokens (0 if no write premium). */
  cacheWrite: number;
  /** USD per 1M cache read tokens. */
  cacheRead: number;
}

export interface ModelCapabilities {
  thinking: boolean;
  tools: boolean;
  streaming: boolean;
  caching: boolean;
}

export interface TierDefaults {
  large: string;
  medium: string;
  small: string;
}

export interface KnownModelsData {
  models: Record<string, KnownModelEntry>;
  tierDefaults: Record<string, TierDefaults>;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let cached: KnownModelsData | null = null;

/**
 * Load the model registry: shipped known-models.json merged with user overrides.
 *
 * @param configDir — User config directory for model-overrides.json
 * @param opts.reset — Clear cache (for tests)
 */
export function loadModelRegistry(configDir?: string, opts?: { reset?: boolean }): KnownModelsData {
  if (opts?.reset) cached = null;
  if (cached) return cached;

  // Load shipped models
  const shippedPath = join(dirname(fileURLToPath(import.meta.url)), "known-models.json");
  const shipped: KnownModelsData = JSON.parse(readFileSync(shippedPath, "utf-8"));

  // Merge user overrides
  if (configDir) {
    try {
      const overridePath = join(configDir, "model-overrides.json");
      const overrides = JSON.parse(readFileSync(overridePath, "utf-8"));

      if (overrides.models && typeof overrides.models === "object") {
        for (const [id, entry] of Object.entries(overrides.models)) {
          if (shipped.models[id]) {
            // Merge: override fields on existing model
            shipped.models[id] = { ...shipped.models[id], ...(entry as Partial<KnownModelEntry>) };
          } else {
            // New model from user override
            shipped.models[id] = entry as KnownModelEntry;
          }
        }
      }

      if (overrides.tierDefaults && typeof overrides.tierDefaults === "object") {
        for (const [provider, defaults] of Object.entries(overrides.tierDefaults)) {
          shipped.tierDefaults[provider] = {
            ...(shipped.tierDefaults[provider] ?? {}),
            ...(defaults as Partial<TierDefaults>),
          } as TierDefaults;
        }
      }
    } catch {
      // No overrides file or invalid JSON — use shipped defaults
    }
  }

  cached = shipped;
  return shipped;
}

/**
 * Get a known model entry by ID. Returns undefined for unknown models.
 */
export function getKnownModel(modelId: string, configDir?: string): KnownModelEntry | undefined {
  return loadModelRegistry(configDir).models[modelId];
}

/**
 * Get all known models for a given provider.
 */
export function getModelsForProvider(provider: string, configDir?: string): Record<string, KnownModelEntry> {
  const registry = loadModelRegistry(configDir);
  const result: Record<string, KnownModelEntry> = {};
  for (const [id, entry] of Object.entries(registry.models)) {
    if (entry.provider === provider) {
      result[id] = entry;
    }
  }
  return result;
}

/**
 * Get pricing for a model. Returns undefined for unknown models.
 */
export function getModelPricing(modelId: string, configDir?: string): ModelPricing | undefined {
  return getKnownModel(modelId, configDir)?.pricing;
}

/**
 * Get the default tier assignments for a provider.
 */
export function getTierDefaults(provider: string, configDir?: string): TierDefaults | undefined {
  return loadModelRegistry(configDir).tierDefaults[provider];
}

/**
 * List all known model IDs.
 */
export function listKnownModelIds(configDir?: string): string[] {
  return Object.keys(loadModelRegistry(configDir).models);
}
