import type { LLMProvider } from "../../providers/types.js";
import type { GameState } from "../game-state.js";
import type { FileIO } from "../scene-manager.js";
import type { UsageStats } from "../agent-loop.js";
import { oneShot } from "../subagent.js";
import { extractWikilinks, uniqueTargets } from "../../tools/filesystem/index.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { accUsage } from "../../context/usage-helpers.js";
import { norm } from "../../utils/paths.js";

export interface RepairResult {
  found: string[];
  existing: string[];
  missing: string[];
  generated: string[];
  errors: string[];
  dryRun: boolean;
  usage: UsageStats;
}

/**
 * Classify a wikilink target into an entity type based on its relative path.
 * Returns null if the target doesn't map to a known entity directory.
 */
function classifyTarget(target: string): { type: string; name: string; filePath: string } | null {
  // Normalize backslashes and strip leading ./
  const normalized = target.replace(/\\/g, "/").replace(/^\.\//, "");

  // Direct paths like "characters/kael.md"
  const directMatch = normalized.match(/^(characters|locations|factions|lore|items)\/(.+)$/);
  if (directMatch) {
    const type = directMatch[1];
    let name = directMatch[2];
    // Strip .md extension and /index for locations
    name = name.replace(/\/index\.md$/, "").replace(/\.md$/, "");
    return { type, name, filePath: normalized };
  }

  // Relative paths from within scenes like "../characters/kael.md"
  const relMatch = normalized.match(/(?:\.\.\/)+?(characters|locations|factions|lore|items)\/(.+)$/);
  if (relMatch) {
    const type = relMatch[1];
    let name = relMatch[2];
    name = name.replace(/\/index\.md$/, "").replace(/\.md$/, "");
    const filePath = `${type}/${name}${type === "locations" ? "/index.md" : ".md"}`;
    return { type, name, filePath };
  }

  return null;
}

/**
 * Scan all scene transcripts and collect wikilink targets.
 */
async function scanTranscripts(
  root: string,
  fileIO: FileIO,
): Promise<{ targets: string[]; excerpts: Map<string, string[]> }> {
  const scenesDir = norm(root) + "/campaign/scenes";
  const excerpts = new Map<string, string[]>();
  const allTargets: string[] = [];

  let sceneDirs: string[];
  try {
    sceneDirs = await fileIO.listDir(scenesDir);
  } catch {
    return { targets: [], excerpts };
  }

  for (const dir of sceneDirs) {
    const transcriptPath = norm(scenesDir) + "/" + dir + "/transcript.md";
    let content: string;
    try {
      content = await fileIO.readFile(transcriptPath);
    } catch {
      continue;
    }

    const links = extractWikilinks(content);
    const targets = uniqueTargets(links);
    allTargets.push(...targets);

    // Collect excerpt lines for each target (for generation context)
    const lines = content.split("\n");
    for (const link of links) {
      const key = link.target;
      if (!excerpts.has(key)) excerpts.set(key, []);
      // Grab the line containing the link and 1 line before/after
      const lineIdx = link.line - 1;
      const start = Math.max(0, lineIdx - 1);
      const end = Math.min(lines.length, lineIdx + 2);
      const snippet = lines.slice(start, end).join("\n");
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- just set above
    const arr = excerpts.get(key)!;
      if (arr.length < 5) arr.push(snippet);
    }
  }

  return { targets: [...new Set(allTargets)], excerpts };
}

/**
 * Inventory existing entity files.
 */
async function inventoryEntities(
  root: string,
  fileIO: FileIO,
): Promise<Set<string>> {
  const existing = new Set<string>();
  const dirs = ["characters", "locations", "factions", "lore", "items"];

  for (const dir of dirs) {
    const dirPath = norm(root) + "/" + dir;
    let entries: string[];
    try {
      entries = await fileIO.listDir(dirPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        existing.add(`${dir}/${entry}`);
      } else {
        // Could be a location subdirectory — check for index.md
        const indexPath = norm(dirPath) + "/" + entry + "/index.md";
        if (await fileIO.exists(indexPath)) {
          existing.add(`${dir}/${entry}/index.md`);
        }
      }
    }
  }

  return existing;
}

/**
 * Parse the ===filename=== delimited output from the generation prompt.
 */
export function parseGeneratedEntities(output: string): { filePath: string; content: string }[] {
  const results: { filePath: string; content: string }[] = [];
  const parts = output.split(/^===(.+?)===$/m);

  // parts[0] is preamble (before first delimiter), then alternating: filename, content
  for (let i = 1; i < parts.length; i += 2) {
    const filePath = parts[i].trim();
    const content = (parts[i + 1] ?? "").trim();
    if (filePath && content) {
      results.push({ filePath, content: content + "\n" });
    }
  }

  return results;
}

/**
 * Repair missing entity files by scanning transcripts for wikilinks,
 * identifying entities without files, and generating stubs via Haiku.
 */
export async function repairState(
  provider: LLMProvider,
  gameState: GameState,
  fileIO: FileIO,
  dryRun: boolean,
  model: string,
): Promise<RepairResult> {
  const root = gameState.campaignRoot;
  const totalUsage: UsageStats = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  };

  const result: RepairResult = {
    found: [],
    existing: [],
    missing: [],
    generated: [],
    errors: [],
    dryRun,
    usage: totalUsage,
  };

  // Step 1: Scan transcripts for wikilinks
  const { targets, excerpts } = await scanTranscripts(root, fileIO);

  // Step 2: Classify targets into entity types
  const classified = targets
    .map((t) => ({ raw: t, ...classifyTarget(t) }))
    .filter((c): c is { raw: string; type: string; name: string; filePath: string } => c.type !== undefined);

  result.found = classified.map((c) => c.filePath);

  // Step 3: Inventory existing files
  const existingFiles = await inventoryEntities(root, fileIO);
  result.existing = classified
    .filter((c) => existingFiles.has(c.filePath))
    .map((c) => c.filePath);

  // Step 4: Diff — find missing
  const missingEntities = classified.filter((c) => !existingFiles.has(c.filePath));
  result.missing = missingEntities.map((c) => c.filePath);

  if (missingEntities.length === 0) {
    return result;
  }

  // Step 5: Generate via Haiku in batches
  const systemPrompt = loadPrompt("repair-generator");
  const batchSize = 5;

  for (let i = 0; i < missingEntities.length; i += batchSize) {
    const batch = missingEntities.slice(i, i + batchSize);

    // Build user message with entity names and transcript excerpts
    const lines: string[] = ["Generate entity files for the following:\n"];
    for (const entity of batch) {
      lines.push(`## ${entity.type}/${entity.name}`);
      const entityExcerpts = excerpts.get(entity.raw) ?? [];
      if (entityExcerpts.length > 0) {
        lines.push("Transcript excerpts:");
        for (const excerpt of entityExcerpts) {
          lines.push("```");
          lines.push(excerpt);
          lines.push("```");
        }
      } else {
        lines.push("(No transcript excerpts available — generate a minimal stub)");
      }
      lines.push("");
    }

    try {
      const genResult = await oneShot(
        provider,
        model,
        systemPrompt,
        lines.join("\n"),
        1024,
        "repair-state",
      );
      accUsage(totalUsage, genResult.usage);

      const entities = parseGeneratedEntities(genResult.text);

      for (const entity of entities) {
        const absPath = norm(root) + "/" + entity.filePath;

        if (dryRun) {
          result.generated.push(entity.filePath);
        } else {
          try {
            // Ensure parent directory exists for locations
            if (entity.filePath.startsWith("locations/")) {
              const parentDir = absPath.replace(/\/[^/]+$/, "");
              await fileIO.mkdir(parentDir);
            }
            await fileIO.writeFile(absPath, entity.content);
            result.generated.push(entity.filePath);
          } catch (e) {
            result.errors.push(`Failed to write ${entity.filePath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } catch (e) {
      const names = batch.map((b) => b.name).join(", ");
      result.errors.push(`Generation failed for batch [${names}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
