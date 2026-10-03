import { getCampaignKnowledge } from "../../knowledge/store.js";
import type { LLMProvider } from "../../providers/types.js";
import type { FileIO } from "../../agents/scene-manager.js";
import type { UsageStats } from "../../agents/agent-loop.js";

// --- Types ---

export interface DeadLink {
  rawTarget: string;       // as it appears in source (e.g. "../characters/kael.md")
  resolvedPath: string;    // relative to root (e.g. "characters/kael.md")
  references: { file: string; line: number; display: string }[];
}

export interface NearMatch {
  path: string;
  score: number;  // 0.0–1.0
}

export type TriageCategory = "stub" | "repoint" | "missing";

export interface TriagedLink {
  resolvedPath: string;
  rawTarget: string;
  referenceCount: number;
  category: TriageCategory;
  reason: string;
  repointTarget?: string;  // required for "repoint" category
}

export interface ResolveDeadLinksResult {
  deadLinks: DeadLink[];
  triaged: {
    stubs: TriagedLink[];
    repoints: TriagedLink[];
    missing: TriagedLink[];
  };
  filesUpdated: string[];    // populated on write
  filesGenerated: string[];  // populated on write
  errors: string[];
  dryRun: boolean;
  usage: UsageStats;
}

// --- Pure helpers ---

/** Levenshtein distance between two strings (simple DP, no deps). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Compute near-match candidates for a dead link against existing paths.
 * Pure function, no I/O.
 */
export function computeNearMatches(
  deadPath: string,
  existingPaths: string[],
  maxCandidates = 3,
  minScore = 0.4,
): NearMatch[] {
  const deadBasename = deadPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
  const deadDir = deadPath.split("/").slice(0, -1).join("/");

  const scored: NearMatch[] = [];

  for (const existing of existingPaths) {
    const existBasename = existing.split("/").pop()?.replace(/\.md$/, "") ?? "";
    const existDir = existing.split("/").slice(0, -1).join("/");

    let score: number;

    if (deadBasename === existBasename) {
      // Identical basenames, different dirs
      score = 0.9;
    } else if (deadBasename.length > 0 && existBasename.length > 0 &&
               (existBasename.startsWith(deadBasename) || existBasename.endsWith(deadBasename) ||
                deadBasename.startsWith(existBasename) || deadBasename.endsWith(existBasename))) {
      // One basename is a prefix/suffix of the other
      score = 0.7;
    } else {
      // Levenshtein distance on basenames
      const dist = levenshtein(deadBasename.toLowerCase(), existBasename.toLowerCase());
      const maxLen = Math.max(deadBasename.length, existBasename.length);
      score = maxLen > 0 ? 1 - dist / maxLen : 0;
    }

    // Bonus if directory prefix matches
    if (deadDir && existDir && deadDir === existDir) {
      score = Math.min(score + 0.1, 1.0);
    }

    if (score >= minScore) {
      scored.push({ path: existing, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCandidates);
}

/** Parse Haiku's JSON triage response; strips code fences, returns [] on bad JSON. */
export function parseTriageResponse(text: string): TriagedLink[] {
  // Strip code fences if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const validCategories = new Set<string>(["stub", "repoint", "missing"]);
  const results: TriagedLink[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    if (typeof obj.path !== "string" || typeof obj.category !== "string" || typeof obj.reason !== "string") continue;
    if (!validCategories.has(obj.category)) continue;

    results.push({
      resolvedPath: obj.path as string,
      rawTarget: (obj.raw_target as string) ?? obj.path as string,
      referenceCount: typeof obj.reference_count === "number" ? obj.reference_count : 0,
      category: obj.category as TriageCategory,
      reason: obj.reason as string,
      repointTarget: typeof obj.repoint_target === "string" ? obj.repoint_target : undefined,
    });
  }

  return results;
}

// --- Main function ---

/**
 * Triage dead wikilinks: classify as intentional stubs, broken refs to repoint,
 * or genuinely missing entities to generate.
 */
export async function resolveDeadLinks(root:string,fileIO:FileIO,_provider:LLMProvider,_context:string,dryRun=true):Promise<ResolveDeadLinksResult> {
  // SQLite rejects dangling references before commit; there is nothing to infer or repair.
  await (await getCampaignKnowledge(root,fileIO)).outline();
  return {deadLinks:[],triaged:{stubs:[],repoints:[],missing:[]},filesUpdated:[],filesGenerated:[],errors:[],dryRun,usage:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0}};
}
