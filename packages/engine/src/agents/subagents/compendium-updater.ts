import { createHash } from "node:crypto";
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
import type { CampaignKnowledgeStore } from "../../knowledge/store.js";
import type { KnowledgeOperation } from "@machine-violet/shared/types/knowledge.js";
import { collectionPath, projectCampaignCompendium } from "../../entities/public-knowledge.js";

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
    collections: {},
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
    if (!parsed.collections && (
      !Array.isArray(parsed.characters) ||
      !Array.isArray(parsed.places) ||
      !Array.isArray(parsed.storyline) ||
      !Array.isArray(parsed.lore) ||
      !Array.isArray(parsed.objectives)
    )) {
      return fallback;
    }

    // Backfill items array for compendiums created before this category existed
    for (const category of COMPENDIUM_CATEGORIES) if (!Array.isArray(parsed[category])) parsed[category] = [];
    if (parsed.collections && (typeof parsed.collections !== "object" || Object.values(parsed.collections).some((entries) => !Array.isArray(entries)))) return fallback;

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
    // Legacy saves predate some categories (e.g. `items`) — backfill so the
    // second pass below can iterate every category unconditionally.
    if (!Array.isArray(entries)) {
      result[category] = [];
      continue;
    }
    const rewritten: CompendiumEntry[] = [];
    for (const entry of entries) {
      const canonical = entry.uid ?? slugify(entry.name);
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
        const mapped = renames.get(ref) ?? (/^k[0-9a-z]+$/i.test(ref) ? ref : canonicalizeSlugRef(ref));
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

/** Publish only model-approved player summaries, separately from private source records. */
export async function commitPublicCompendium(store: CampaignKnowledgeStore, compendium: Compendium, sceneNumber: number): Promise<Compendium> {
  const outline = await store.outline();
  const collections = new Map(outline.filter((entry) => entry.kind === "collection").map((entry) => [collectionPath(entry.uid, outline).toLocaleLowerCase(), entry.uid]));
  const publicRecords = new Map<string, string>();
  for (const entry of outline) {
    if (entry.kind !== "entity") continue;
    const node = await store.read(entry.uid, { textLimit: 0, logLimit: 0 });
    const subject = node.fields.subject;
    if (node.visibility === "player-facing" && subject && typeof subject === "object" && !Array.isArray(subject) && typeof subject.$ref === "string") publicRecords.set(subject.$ref, node.uid);
  }
  const operations: KnowledgeOperation[] = [];
  const planned = new Set<string>();
  const ensureCollection = (path: string): string => {
    const parts = path.split("/").map((part) => part.trim()).filter(Boolean);
    let parent = "root", current = "";
    for (const name of parts) {
      current = current ? `${current}/${name}` : name;
      const existing = collections.get(current.toLocaleLowerCase());
      if (existing) { parent = existing; continue; }
      if (!planned.has(current.toLocaleLowerCase())) {
        operations.push({ op: "create_collection", parent, name, note: current.startsWith("Player Knowledge") ? "Player-approved summaries only; source records may be private." : undefined });
        planned.add(current.toLocaleLowerCase());
      }
      parent = current;
    }
    return parent;
  };
  const defaults: Record<string, string> = { characters: "Characters", places: "Locations", items: "Items", storyline: "Storyline", lore: "Lore", objectives: "Objectives" };
  const groups = compendium.collections && Object.keys(compendium.collections).length ? compendium.collections : Object.fromEntries(COMPENDIUM_CATEGORIES.map((category) => [defaults[category], compendium[category]]));
  const prepared: { collectionName: string; entry: CompendiumEntry; subject: string | null; handle: string }[] = [];
  const subjects = new Map<string, string>();
  for (const [collectionName, entries] of Object.entries(groups)) {
    for (const entry of entries) {
      if (!entry || typeof entry.name !== "string" || typeof entry.summary !== "string" || !entry.name.trim()) continue;
      const subject = await store.resolve(entry.uid ?? entry.name);
      const handle = subject ?? entry.name;
      if (!subject) {
        operations.push({ op: "upsert", collection: ensureCollection(collectionName), name: entry.name,
          aliases: [...(entry.aliases ?? []), entry.slug].filter(Boolean), visibility: "private" });
      }
      for (const alias of [entry.uid, entry.slug, entry.name, ...(entry.aliases ?? [])]) if (alias) subjects.set(alias.normalize("NFKC").trim().toLocaleLowerCase(), handle);
      prepared.push({ collectionName, entry, subject, handle });
    }
  }
  // All canonical subjects precede references, including identities introduced
  // in this very batch. The transaction resolves these handles to UIDs.
  for (const { collectionName, entry, subject, handle } of prepared) {
    const related: { $ref: string }[] = [];
    for (const ref of entry.related ?? []) {
      const target = await store.resolve(ref) ?? subjects.get(ref.normalize("NFKC").trim().toLocaleLowerCase());
      if (target) related.push({ $ref: target });
    }
    operations.push({ op: "upsert", collection: ensureCollection(`Player Knowledge/${collectionName}`), uid: subject ? publicRecords.get(subject) : undefined,
      name: `Player memory: ${handle}`, visibility: "player-facing",
      fields: { subject: { $ref: handle }, display_name: entry.name, public_aliases: entry.aliases ?? [], summary: entry.summary,
        firstScene: entry.firstScene ?? sceneNumber, lastScene: sceneNumber, public_related: related },
      history: `Player learned: ${entry.summary}` });
  }
  if (operations.length) await store.mutate(operations, { sceneNumber, source: "compendium", operationId: `compendium:${sceneNumber}:${createHash("sha256").update(JSON.stringify(groups)).digest("hex")}` });
  return projectCampaignCompendium(store);
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

  if (compendium.collections && Object.keys(compendium.collections).length) {
    for (const [collection, entries] of Object.entries(compendium.collections)) renderCategory(collection, entries);
  } else {
    renderCategory("Characters", compendium.characters);
    renderCategory("Places", compendium.places);
    renderCategory("Items", compendium.items);
    renderCategory("Storyline", compendium.storyline);
    renderCategory("Lore", compendium.lore);
    renderCategory("Objectives", compendium.objectives);
  }

  return lines.join("\n");
}
