import type { LLMProvider } from "../../providers/types.js";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getMaxOutput } from "../../config/model-registry.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { slugify } from "@machine-violet/shared/utils/slug.js";
import {
  COMPENDIUM_CATEGORIES,
  type Compendium,
  type CompendiumEntry,
} from "@machine-violet/shared/types/compendium.js";

/**
 * Create an empty compendium with default structure.
 */
export function emptyCompendium(): Compendium {
  return {
    version: 1,
    lastUpdatedScene: 0,
    characters: [],
    places: [],
    items: [],
    storyline: [],
    lore: [],
    objectives: [],
  };
}

/**
 * Compendium updater subagent.
 * Reads the current compendium and a player-safe scene summary,
 * returns an updated compendium reflecting new player knowledge.
 *
 * @param sceneSummary - Player-safe summary from the scene summarizer (campaign log `full` field).
 *                       Never pass the raw transcript — it may contain DM secrets.
 */
export async function updateCompendium(
  provider: LLMProvider,
  current: Compendium,
  sceneSummary: string,
  sceneNumber: number,
  aliasContext: string | undefined,
  model: string,
): Promise<{ compendium: Compendium; usage: SubagentResult["usage"] }> {
  const userMessage = [
    `Scene ${sceneNumber} summary:\n\n${sceneSummary}`,
    aliasContext ? `\n\n${aliasContext}` : "",
    `\n\nCurrent compendium:\n${JSON.stringify(current, null, 2)}`,
  ].join("");

  const result = await oneShot(
    provider,
    model,
    loadPrompt("compendium-updater", model),
    userMessage,
    getMaxOutput(model),
    "compendium-updater",
  );

  const compendium = parseCompendiumOutput(result.text, current);
  return { compendium, usage: result.usage };
}

/**
 * Parse compendium JSON from subagent output.
 * Falls back to the original compendium if parsing fails.
 */
export function parseCompendiumOutput(
  text: string,
  fallback: Compendium,
): Compendium {
  try {
    // Strip markdown fences if present
    let json = text.trim();
    if (json.startsWith("```")) {
      const firstNewline = json.indexOf("\n");
      const lastFence = json.lastIndexOf("```");
      if (firstNewline !== -1 && lastFence > firstNewline) {
        json = json.slice(firstNewline + 1, lastFence).trim();
      }
    }

    const parsed = JSON.parse(json) as Compendium;

    // Basic validation: must have the expected category arrays
    if (
      !Array.isArray(parsed.characters) ||
      !Array.isArray(parsed.places) ||
      !Array.isArray(parsed.storyline) ||
      !Array.isArray(parsed.lore) ||
      !Array.isArray(parsed.objectives)
    ) {
      return fallback;
    }

    // Backfill items array for compendiums created before this category existed
    if (!Array.isArray(parsed.items)) parsed.items = [];

    // Ensure version field
    parsed.version = 1;
    return canonicalizeCompendium(parsed);
  } catch {
    return fallback;
  }
}

/**
 * Force every entry's `slug` to match `slugify(entry.name)`, and rewrite
 * every `related` array through the same rule. Idempotent.
 *
 * The compendium-updater subagent (and any older saved compendium) has been
 * observed emitting slugs that retain leading articles — "the-city" instead
 * of the canonical "city". That diverges from the slugify() the renderer
 * uses to resolve wikilinks, so every `[[The City]]` link rendered red even
 * though the entry existed. We treat slugify() as authoritative and rewrite
 * the model's output to match, rather than introducing a second slug rule.
 *
 * Slugs we've actually seen change are remapped in `related`; any other
 * slug there is still run through slugify() so a legacy reference like
 * "the-arcade" → "arcade" lines up even if "the-arcade" never appeared as
 * an entry slug in this compendium.
 */
export function canonicalizeCompendium(compendium: Compendium): Compendium {
  const renames = new Map<string, string>();
  const result: Compendium = { ...compendium };

  for (const category of COMPENDIUM_CATEGORIES) {
    const entries = compendium[category];
    if (!Array.isArray(entries)) continue;
    const rewritten: CompendiumEntry[] = [];
    for (const entry of entries) {
      const canonical = slugify(entry.name);
      if (entry.slug !== canonical) renames.set(entry.slug, canonical);
      rewritten.push({ ...entry, slug: canonical });
    }
    result[category] = rewritten;
  }

  for (const category of COMPENDIUM_CATEGORIES) {
    for (const entry of result[category]) {
      if (!Array.isArray(entry.related) || entry.related.length === 0) continue;
      const seen = new Set<string>();
      const next: string[] = [];
      for (const ref of entry.related) {
        const mapped = renames.get(ref) ?? canonicalizeSlugRef(ref);
        if (!seen.has(mapped)) {
          seen.add(mapped);
          next.push(mapped);
        }
      }
      entry.related = next;
    }
  }

  return result;
}

/**
 * Normalize a string that's already in slug form (hyphens, no spaces).
 * slugify() only strips a leading article when followed by whitespace, so
 * `slugify("the-arcade")` returns `"the-arcade"` unchanged — but the
 * canonical slug for the display name "The Arcade" is `"arcade"`. This
 * helper closes that gap for `related[]` cross-references that point to
 * legacy slugs we don't have an entry-level rename for.
 */
function canonicalizeSlugRef(ref: string): string {
  return slugify(ref).replace(/^(the|a|an)-/, "");
}

/**
 * Render the compendium as a compact DM-facing summary.
 * One line per category, wikilinked, terse.
 */
export function renderCompendiumForDM(compendium: Compendium): string {
  const lines: string[] = [];

  const renderCategory = (label: string, entries: CompendiumEntry[]) => {
    if (entries.length === 0) return;
    const items = entries.map((e) => {
      // Extract a short descriptor from the summary (first clause)
      const desc = e.summary.split(/[.!?]/)[0]?.trim();
      const shortDesc = desc && desc.length < 60 ? ` (${desc.toLowerCase()})` : "";
      return `[[${e.name}]]${shortDesc}`;
    });
    lines.push(`${label}: ${items.join(", ")}`);
  };

  renderCategory("Characters", compendium.characters);
  renderCategory("Places", compendium.places);
  renderCategory("Items", compendium.items);
  renderCategory("Storyline", compendium.storyline);
  renderCategory("Lore", compendium.lore);
  renderCategory("Objectives", compendium.objectives);

  return lines.join("\n");
}
