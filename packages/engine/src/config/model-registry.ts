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
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnownModelEntry {
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  defaultTier: "large" | "medium" | "small";
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
  /**
   * Model supports inline image generation as part of a chat turn. When
   * absent, treat as false — the field is opt-in so older registry entries
   * don't have to be updated when a new capability bit is added.
   */
  imageGeneration?: boolean;
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
  const shippedPath = join(assetDir("config"), "known-models.json");
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
 * Get all known models for a given provider/model family.
 *
 * Note the parameter is a *model family* identifier (e.g. `"openai"`,
 * `"anthropic"`), not a connection-type. The OpenAI model family is
 * shared by both `openai-apikey` and `openai-chatgpt` connections —
 * callers that have a connection-type in hand should map through
 * {@link modelFamilyFor} first.
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
 * Map a connection-type (the discriminator on `AIConnection.provider`) to
 * the model-family identifier used in {@link KnownModelEntry.provider}.
 *
 * We split the two namespaces because `openai-apikey` and `openai-chatgpt`
 * connections both reach the same family of GPT-5.x models, but each
 * connection-type has its own tier-defaults entry in `known-models.json`
 * (different defaults: ChatGPT auth doesn't expose `gpt-5-nano`).
 */
export function modelFamilyFor(connectionProvider: string): string {
  if (connectionProvider === "openai-apikey" || connectionProvider === "openai-chatgpt") {
    return "openai";
  }
  return connectionProvider;
}

/**
 * Get pricing for a model. Returns undefined for unknown models.
 */
export function getModelPricing(modelId: string, configDir?: string): ModelPricing | undefined {
  return getKnownModel(modelId, configDir)?.pricing;
}

/**
 * Fallback `max_tokens` value for models not present in the registry.
 *
 * Generous enough that the DM, scribe, and any plausible subagent can run
 * to natural completion without truncating; not so high that an out-of-control
 * loop bleeds money before something else catches it. If you ever ship a
 * registry with a model whose maxOutput is *less* than this, the registry
 * value still wins — this constant only applies when lookup fails.
 */
const FALLBACK_MAX_OUTPUT = 16384;

/**
 * Get the model's maximum output tokens — the natural ceiling on any single
 * response. Used as `max_tokens` for every API call in the engine: passing
 * a smaller artificial cap risks truncating tool-call JSON or DM narrative
 * mid-emission (the original sin behind the GPT-5.5 setup-finalize bug).
 *
 * Cost is unaffected — providers bill on actual output tokens, not the cap.
 *
 * Returns {@link FALLBACK_MAX_OUTPUT} for models not in the registry.
 */
export function getMaxOutput(modelId: string, configDir?: string): number {
  return getKnownModel(modelId, configDir)?.maxOutput ?? FALLBACK_MAX_OUTPUT;
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

/**
 * Whether the named model can emit inline image generation. Unknown models
 * (custom OpenAI-compatible endpoints, off-registry overrides) default to
 * false — the safer bet, since enabling the tool against a model that
 * doesn't understand it produces noisy turn failures rather than a
 * graceful skip.
 */
export function supportsImageGeneration(modelId: string, configDir?: string): boolean {
  return getKnownModel(modelId, configDir)?.capabilities.imageGeneration === true;
}
