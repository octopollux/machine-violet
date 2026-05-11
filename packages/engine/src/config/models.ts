import type { ModelId } from "../agents/agent-loop.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelTier } from "@machine-violet/shared/types/engine.js";
export type { ModelTier } from "@machine-violet/shared/types/engine.js";

export type EffortLevel = "low" | "medium" | "high" | "max";

const VALID_EFFORT_LEVELS = new Set<string>(["low", "medium", "high", "max"]);

export interface ModelConfig {
  large: ModelId;
  medium: ModelId;
  small: ModelId;
  /**
   * Per-agent effort configuration.
   * Keys are agent names (e.g. "dm", "ooc", "scene-summarizer").
   * Values: effort level string, or null to omit (API default).
   * The "default" key serves as fallback for unconfigured agents.
   */
  effort: Record<string, EffortLevel | null>;
}

export interface EffortConfig {
  effort: EffortLevel | null;
}

const DEV_CONFIG_FILENAME = "dev-config.jsonc";

/**
 * Strip JSONC comments (line and block) from a source string while preserving
 * content inside double-quoted strings. Recognizes:
 *   - `//` to end-of-line
 *   - block comments delimited by slash-star and star-slash
 * Trailing commas are not supported — keep the file syntactically JSON once
 * comments are removed.
 *
 * Hand-rolled to avoid pulling in a JSONC parser dep for a single config file.
 * Single-quoted strings are not recognized (JSON doesn't allow them).
 */
function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      // keep the newline so line numbers in error messages stay accurate
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function loadDevConfig(dir: string): unknown {
  const raw = readFileSync(join(dir, DEV_CONFIG_FILENAME), "utf-8");
  return JSON.parse(stripJsoncComments(raw));
}

const DEFAULTS: ModelConfig = {
  large: "claude-opus-4-6",
  medium: "claude-sonnet-4-6",
  small: "claude-haiku-4-5-20251001",
  effort: {
    "default": null,
    "dm": "high",
    "ooc": "high",
    "setup": "high",
    "dev-mode": "high",
    "ai-player": "low",
    "promote_character": "medium",
    "repair-state": "medium",
  },
};

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
 * Load model config: defaults merged with optional `dev-config.jsonc` effort overrides.
 *
 * Tier model IDs (`large`/`medium`/`small`) returned here are baked-in defaults.
 * Many callers — subagents (scribe, summarizer, precis-updater, etc.), content
 * pipeline, fallbacks — still consult them via `getModel(tier)`. The user-facing
 * Connections UI writes its tier→provider+model assignments to `connections.json`,
 * which currently overrides only the DM's model selection at session start; the
 * subagent call sites have not yet been migrated to the connection store, so they
 * continue to receive these defaults. See PR #440 follow-up for the broader
 * migration.
 *
 * Reads from cwd. Result is cached after first call. Pass `reset: true` in tests.
 */
export function loadModelConfig(opts?: { cwd?: string; reset?: boolean }): ModelConfig {
  if (opts?.reset) cached = null;
  if (cached) return cached;

  const config = { ...DEFAULTS };
  const dir = opts?.cwd ?? process.cwd();

  try {
    const parsed = loadDevConfig(dir) as { effort?: unknown };
    const effort = parsed?.effort;
    if (effort && typeof effort === "object" && !Array.isArray(effort)) {
      const map: Record<string, EffortLevel | null> = {};
      for (const [key, val] of Object.entries(effort)) {
        if (val === null || val === "none") {
          map[key] = null;
        } else if (typeof val === "string" && VALID_EFFORT_LEVELS.has(val)) {
          map[key] = val as EffortLevel;
        }
        // Skip invalid entries silently
      }
      if (Object.keys(map).length > 0) {
        config.effort = { ...DEFAULTS.effort, ...map };
      }
    }
  } catch {
    // No dev-config.jsonc or invalid — use defaults
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
 * Look up effort configuration for a named agent.
 * Falls back to the "default" key, then null (API default).
 *
 * When effort is set, the caller should send `output_config: { effort }`
 * and omit `thinking` (the API handles thinking implicitly).
 * When effort is null, the caller should send `thinking: { type: "disabled" }`.
 */
export function getEffortConfig(agentName: string): EffortConfig {
  const map = loadModelConfig().effort;
  const level = agentName in map ? map[agentName] : (map["default"] ?? null);
  return { effort: level };
}

/**
 * Load pricing config: defaults merged with optional `dev-config.jsonc` overrides.
 * Pricing overrides are keyed by model ID string.
 * Pass `reset: true` in tests to clear cache.
 */
export function loadPricingConfig(opts?: { cwd?: string; reset?: boolean }): Record<string, ModelPricing> {
  if (opts?.reset) cachedPricing = null;
  if (cachedPricing) return cachedPricing;

  const pricing: Record<string, ModelPricing> = { ...DEFAULT_PRICING };
  const dir = opts?.cwd ?? process.cwd();

  try {
    const parsed = loadDevConfig(dir) as { pricing?: unknown };
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
    // No dev-config.jsonc or invalid — use defaults
  }

  cachedPricing = pricing;
  return pricing;
}
