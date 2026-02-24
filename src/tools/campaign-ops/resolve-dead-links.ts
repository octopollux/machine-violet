import type Anthropic from "@anthropic-ai/sdk";
import type { FileIO } from "../../agents/scene-manager.js";
import type { UsageStats } from "../../agents/agent-loop.js";
import { oneShot } from "../../agents/subagent.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { accUsage } from "../../context/usage-helpers.js";
import { walkCampaignFiles } from "./walk-campaign.js";
import { rewriteLinks } from "./rename-entity.js";
import { extractWikilinks } from "../filesystem/wikilinks.js";
import { resolveRelativePath } from "../filesystem/validation.js";
import { parseGeneratedEntities } from "../../agents/subagents/repair-state.js";
import { norm } from "../../utils/paths.js";

// --- Types ---

export interface DeadLink {
  rawTarget: string;       // as it appears in source (e.g. "../characters/kael.md")
  resolvedPath: string;    // relative to root (e.g. "characters/kael.md")
  references: Array<{ file: string; line: number; display: string }>;
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
export async function resolveDeadLinks(
  root: string,
  fileIO: FileIO,
  client: Anthropic,
  context: string,
  dryRun = true,
): Promise<ResolveDeadLinksResult> {
  const normalizedRoot = norm(root);
  const totalUsage: UsageStats = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  };

  const result: ResolveDeadLinksResult = {
    deadLinks: [],
    triaged: { stubs: [], repoints: [], missing: [] },
    filesUpdated: [],
    filesGenerated: [],
    errors: [],
    dryRun,
    usage: totalUsage,
  };

  // --- Phase 1: Collect dead links ---
  const campaignFiles = await walkCampaignFiles(root, fileIO);
  const existingPaths = new Set(campaignFiles.map((f) => f.relativePath));

  const deadLinkMap = new Map<string, DeadLink>();

  for (const file of campaignFiles) {
    const links = extractWikilinks(file.content);
    for (const link of links) {
      const resolved = resolveRelativePath(file.relativePath, link.target);
      if (!existingPaths.has(resolved)) {
        let entry = deadLinkMap.get(resolved);
        if (!entry) {
          entry = { rawTarget: link.target, resolvedPath: resolved, references: [] };
          deadLinkMap.set(resolved, entry);
        }
        entry.references.push({ file: file.relativePath, line: link.line, display: link.display });
      }
    }
  }

  result.deadLinks = [...deadLinkMap.values()];

  if (result.deadLinks.length === 0) {
    return result;
  }

  // --- Phase 2: Near-match scoring ---
  const existingPathsList = [...existingPaths];
  const nearMatches = new Map<string, NearMatch[]>();

  for (const dead of result.deadLinks) {
    const matches = computeNearMatches(dead.resolvedPath, existingPathsList);
    if (matches.length > 0) {
      nearMatches.set(dead.resolvedPath, matches);
    }
  }

  // --- Phase 3: Haiku triage ---
  const systemPrompt = loadPrompt("resolve-dead-links");
  const batchSize = 10;

  for (let i = 0; i < result.deadLinks.length; i += batchSize) {
    const batch = result.deadLinks.slice(i, i + batchSize);

    const lines: string[] = [
      `User context: ${context}`,
      "",
      "Dead links to triage:",
      "",
    ];

    for (const dead of batch) {
      lines.push(`- path: ${dead.resolvedPath}`);
      lines.push(`  raw_target: ${dead.rawTarget}`);
      lines.push(`  reference_count: ${dead.references.length}`);
      const refs = dead.references.slice(0, 3);
      lines.push(`  sample_refs: ${refs.map((r) => `${r.file}:${r.line} [${r.display}]`).join(", ")}`);
      const matches = nearMatches.get(dead.resolvedPath);
      if (matches) {
        lines.push(`  near_matches: ${matches.map((m) => `${m.path} (${m.score.toFixed(2)})`).join(", ")}`);
      }
      lines.push("");
    }

    lines.push("Existing file inventory:");
    for (const p of existingPathsList) {
      lines.push(`  ${p}`);
    }

    try {
      const triageResult = await oneShot(
        client,
        getModel("small"),
        systemPrompt,
        lines.join("\n"),
        1024,
        "resolve-dead-links",
      );
      accUsage(totalUsage, triageResult.usage);

      const triaged = parseTriageResponse(triageResult.text);
      for (const item of triaged) {
        switch (item.category) {
          case "stub":
            result.triaged.stubs.push(item);
            break;
          case "repoint":
            result.triaged.repoints.push(item);
            break;
          case "missing":
            result.triaged.missing.push(item);
            break;
        }
      }
    } catch (e) {
      const paths = batch.map((b) => b.resolvedPath).join(", ");
      result.errors.push(`Triage failed for batch [${paths}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --- Phase 4: Execute actions (when dryRun=false) ---
  if (!dryRun) {
    // 4a. Repoints first
    for (const repoint of result.triaged.repoints) {
      if (!repoint.repointTarget) {
        result.errors.push(`Repoint for ${repoint.resolvedPath} missing target`);
        continue;
      }

      for (const file of campaignFiles) {
        const { content: updated, count } = rewriteLinks(
          file.content,
          file.relativePath,
          repoint.resolvedPath,
          repoint.repointTarget,
        );
        if (count > 0) {
          try {
            await fileIO.writeFile(normalizedRoot + "/" + file.relativePath, updated);
            // Update in-memory content for subsequent repoints
            file.content = updated;
            if (!result.filesUpdated.includes(file.relativePath)) {
              result.filesUpdated.push(file.relativePath);
            }
          } catch (e) {
            result.errors.push(`Failed to update ${file.relativePath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }

    // 4b. Generate stubs for missing entities
    if (result.triaged.missing.length > 0) {
      const genSystemPrompt = loadPrompt("repair-generator");
      const genBatchSize = 5;

      for (let i = 0; i < result.triaged.missing.length; i += genBatchSize) {
        const batch = result.triaged.missing.slice(i, i + genBatchSize);

        const genLines: string[] = ["Generate entity files for the following:\n"];
        for (const item of batch) {
          const dead = deadLinkMap.get(item.resolvedPath);
          genLines.push(`## ${item.resolvedPath}`);
          genLines.push(`Reason: ${item.reason}`);
          if (dead && dead.references.length > 0) {
            genLines.push("References:");
            for (const ref of dead.references.slice(0, 5)) {
              genLines.push(`  ${ref.file}:${ref.line} [${ref.display}]`);
            }
          }
          genLines.push("");
        }

        try {
          const genResult = await oneShot(
            client,
            getModel("small"),
            genSystemPrompt,
            genLines.join("\n"),
            1024,
            "resolve-dead-links-gen",
          );
          accUsage(totalUsage, genResult.usage);

          const entities = parseGeneratedEntities(genResult.text);
          for (const entity of entities) {
            const absPath = normalizedRoot + "/" + entity.filePath;
            try {
              if (entity.filePath.startsWith("locations/")) {
                const parentDir = absPath.replace(/\/[^/]+$/, "");
                await fileIO.mkdir(parentDir);
              }
              await fileIO.writeFile(absPath, entity.content);
              result.filesGenerated.push(entity.filePath);
            } catch (e) {
              result.errors.push(`Failed to write ${entity.filePath}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } catch (e) {
          const paths = batch.map((b) => b.resolvedPath).join(", ");
          result.errors.push(`Generation failed for batch [${paths}]: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return result;
}
