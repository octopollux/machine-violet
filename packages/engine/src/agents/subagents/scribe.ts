import type { LLMProvider } from "../../providers/types.js";
import { spawnSubagent, cacheSystemPrompt } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getMaxOutput } from "../../config/model-registry.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { dirname } from "node:path";
import { machinePaths } from "../../tools/filesystem/index.js";
import { parseFrontMatter, serializeEntity } from "../../tools/filesystem/index.js";
import type { EntityTree } from "@machine-violet/shared/types/entities.js";
import { Type } from "@sinclair/typebox";
import { getCampaignKnowledge, type KnowledgeFileIO } from "../../knowledge/store.js";
import { ENTITY_TOOLS, ENTITY_INPUT_POLICIES, buildKnowledgeToolHandler } from "../../entities/tools.js";
import { defineToolContract, validateToolInput, type ToolInputPolicy } from "../tool-contract.js";

import { slugify } from "../world-builder.js";

// --- Types ---

export interface ScribeUpdate {
  visibility: "private" | "player-facing";
  content: string;
}

export interface ScribeInput {
  updates: ScribeUpdate[];
  campaignRoot: string;
  sceneNumber: number;
  /** Current entity tree — injected into Scribe context for deduplication. */
  entityTree?: EntityTree;
  /** Machine-scope home dir (~/.machine-violet) for player entity paths. */
  homeDir: string;
}

/** Delta returned by the Scribe for each entity created or updated. */
export interface ScribeEntityDelta {
  slug: string;
  name: string;
  aliases: string[];
  type: string;
  path: string;
}

export interface ScribeResult {
  /** Terse summary of what was written */
  summary: string;
  /** Entities created (file paths) */
  created: string[];
  /** Entities updated (file paths) */
  updated: string[];
  /** Entity tree deltas — entries to upsert into the entity tree */
  entityDeltas: ScribeEntityDelta[];
  /** Slugs to remove from the entity tree (e.g. after a rename). */
  removedSlugs: string[];
  /** Usage stats */
  usage: UsageStats;
}

/** Abstraction for file I/O so tests can inject mocks */
export interface ScribeFileIO extends KnowledgeFileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  /** Optional. Required for `rename_entity`. */
  deleteFile?(path: string): Promise<void>;
  /** Optional. Used by `rename_entity` to clean up an emptied location dir. */
  rmdir?(path: string): Promise<void>;
}

/**
 * Re-export sanitizeFrontMatter from its canonical home. EntityStore.create
 * /update use the same repair, so the implementation moved to the shared
 * frontmatter module — this re-export keeps existing scribe.ts imports
 * stable.
 */
export { sanitizeFrontMatter } from "../../tools/filesystem/frontmatter.js";

/** Heading pattern: a `## ` at the start of a line (not `###` or deeper). */
const H2_RE = /^## (?!#)/m;

/**
 * Strip trailing *blank lines* (empty or whitespace-only) from a chunk of
 * markdown. Only whole trailing blank lines go — meaningful trailing whitespace
 * on the last content line (e.g. the two-space markdown hard break) is left
 * intact, because the pattern only matches from a newline onward.
 */
function stripTrailingBlankLines(s: string): string {
  return s.replace(/(?:\n[ \t]*)+$/, "");
}

/**
 * Split a markdown body into sections keyed by `## Heading`.
 * Returns an array of { heading, content } where heading is the full
 * `## Foo` line (or "" for preamble text before the first heading).
 * Content includes the heading line itself.
 *
 * Trailing *blank lines* are stripped from each section's content (via
 * {@link stripTrailingBlankLines}): the blank line that visually separates one
 * section from the next is *presentation*, re-added by the joiner (see
 * {@link mergeSectionBodies}). If it were kept in `content`, every merge would
 * join sections whose content already ends in the separator with another
 * `\n\n`, so each write would grow the gaps by a blank line — a slow, silent
 * newline-accumulation bug across an entity's lifetime. Stripping here makes a
 * parse→merge round-trip idempotent (and self-heals a file that already
 * accumulated runs, the next time it is written).
 */
export function splitSections(body: string): { heading: string; content: string }[] {
  if (!H2_RE.test(body)) return [{ heading: "", content: stripTrailingBlankLines(body) }];

  const sections: { heading: string; content: string }[] = [];
  const lines = body.split("\n");
  let current: { heading: string; lines: string[] } | null = null;
  const finish = () => {
    if (current) sections.push({ heading: current.heading, content: stripTrailingBlankLines(current.lines.join("\n")) });
  };

  for (const line of lines) {
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      finish();
      current = { heading: line, lines: [line] };
    } else {
      if (!current) {
        current = { heading: "", lines: [] };
      }
      current.lines.push(line);
    }
  }
  finish();

  return sections;
}

/**
 * Merge incoming body into existing body with section-aware replacement.
 * - If the incoming body contains `## Heading` blocks that match existing ones,
 *   those sections are replaced in-place.
 * - Genuinely new sections are appended at the end.
 * - If neither body has `## ` headings, falls back to simple append (legacy behavior).
 */
export function mergeSectionBodies(existing: string, incoming: string): string {
  // If incoming has no ## headings, append as before (backward compat for
  // plain-text updates like adding a paragraph of description). Strip trailing
  // blanks off `existing` first so a preamble that ends in blank lines can't
  // combine with the `\n\n` joiner into a growing gap.
  if (!H2_RE.test(incoming)) {
    return existing ? `${stripTrailingBlankLines(existing)}\n\n${incoming}` : incoming;
  }

  const existingSections = splitSections(existing);
  const incomingSections = splitSections(incoming);

  // Build a set of existing headings for lookup
  const existingHeadings = new Map<string, number>();
  for (let i = 0; i < existingSections.length; i++) {
    if (existingSections[i].heading) {
      existingHeadings.set(existingSections[i].heading, i);
    }
  }

  // Replace matched sections in-place
  const replaced = new Set<string>();
  for (const section of incomingSections) {
    if (!section.heading) continue; // skip incoming preamble — don't overwrite existing preamble
    const idx = existingHeadings.get(section.heading);
    if (idx !== undefined) {
      existingSections[idx] = section;
      replaced.add(section.heading);
    }
  }

  // Collect genuinely new sections (not replacements, not preamble)
  const newSections = incomingSections.filter(
    s => s.heading && !replaced.has(s.heading),
  );

  const parts = existingSections.map(s => s.content);
  for (const s of newSections) parts.push(s.content);

  return parts.join("\n\n");
}

// --- Campaign and machine-profile tools ---

export const PLAYER_PROFILE_CONTRACT = defineToolContract({
  name: "player_profile", criticality: "durable",
  description: "Read a real-world player's machine profile or append a factual private note. Campaign characters belong in campaign memory. Content Boundaries may only be appended, never removed.",
  schema: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("append")]), player: Type.String({ minLength: 1 }), text: Type.Optional(Type.String()), section: Type.Optional(Type.String()) }, { additionalProperties: false }),
  refine: (input) => input.action === "append" && !input.text?.trim()
    ? [{ path: "/text", code: "required", expected: "nonempty note", actual: "absent", message: "append requires text" }] : [],
});

export function buildScribeToolHandler(
  fileIO: ScribeFileIO, campaignRoot: string, sceneNumber: number,
  _created: string[], updated: string[], _entityDeltas: ScribeEntityDelta[],
  _removedSlugs: string[] = [], homeDir?: string,
) {
  return async (name: string, input: Record<string, unknown>): Promise<{ content: string; is_error?: boolean }> => {
    if (name === "player_profile") {
      const validation = validateToolInput(PLAYER_PROFILE_CONTRACT.definition, input, PLAYER_PROFILE_CONTRACT.policy);
      if (!validation.ok) return { content: validation.content, is_error: true };
      if (!homeDir) return { content: "Machine player profiles require homeDir", is_error: true };
      const path = machinePaths(homeDir).player(slugify(input.player as string));
      try {
        let raw = "";
        try { raw = await fileIO.readFile(path); } catch { /* new profile */ }
        if (input.action === "read") return { content: raw || "(no profile)" };
        const section = String(input.section ?? "Notes").replace(/[\r\n]/g, " ").trim();
        if (!section) return { content: "section must not be empty", is_error: true };
        const text = String(input.text).trim();
        const { frontMatter, body, changelog } = parseFrontMatter(raw);
        const heading = `## ${section}`;
        const sections = splitSections(body);
        const existing = sections.find((part) => part.heading === heading);
        const addition = existing ? `${existing.content}\n- ${text}` : `${heading}\n- ${text}`;
        const merged = mergeSectionBodies(body, addition);
        await fileIO.mkdir(dirname(path));
        await fileIO.writeFile(path, serializeEntity(String(frontMatter._title ?? input.player), { ...frontMatter, type: "player" }, merged, changelog));
        updated.push(path);
        return { content: `Appended private ${section} note for ${input.player}` };
      } catch (error) { return { content: error instanceof Error ? error.message : String(error), is_error: true }; }
    }
    const store = await getCampaignKnowledge(campaignRoot, fileIO);
    const result = await buildKnowledgeToolHandler(store, { sceneNumber, source: "scribe" })(name, input);
    if (!result) return { content: `Unknown tool: ${name}`, is_error: true };
    if (name === "remember" && !result.is_error) {
      const committed = JSON.parse(result.content) as { changed: string[] };
      updated.push(...committed.changed);
    }
    return result;
  };
}

/** Bounded canonical records supplement the complete latest organization. */
export async function buildPrefetchedEntityBlock(
  updates: ScribeUpdate[], _entityTree: EntityTree | undefined,
  campaignRoot: string, fileIO: ScribeFileIO, _homeDir?: string, maxEntities = 8,
): Promise<string> {
  const store = await getCampaignKnowledge(campaignRoot, fileIO);
  const text = updates.map((update) => update.content).join("\n").toLocaleLowerCase();
  const blocks: string[] = [];
  let remaining = 12000;
  const outline = await store.outline();
  const byUid = new Map(outline.map((entry) => [entry.uid, entry]));
  for (const entry of outline) {
    if (entry.kind !== "entity" || blocks.length >= maxEntities || remaining <= 0) continue;
    const node = await store.read(entry.uid, { textLimit: 0, logLimit: 0 });
    if (![node.uid, node.name, ...node.aliases].some((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
    })) continue;
    const record = await store.read(node.uid, { textLimit: Math.min(1500, remaining), logLimit: 0, childLimit: 32 });
    // Current narrative facts matter here. Child-node inventories and derived
    // value edges repeat the typed fields and can crowd out other identities.
    const references = [];
    for (const reference of record.references) {
      const leafUid = reference.label.startsWith("value:") ? reference.label.slice(6) : "";
      const leaf = byUid.get(leafUid);
      let owner = leaf?.parent;
      while (owner && byUid.get(owner)?.kind === "value") owner = byUid.get(owner)?.parent;
      if (leaf?.kind === "value" && owner === record.uid && reference.source === record.uid) {
        const value = (await store.read(leaf.uid, { textLimit: 0, logLimit: 0 })).value;
        if (value && typeof value === "object" && !Array.isArray(value) && value.$ref === reference.target) continue;
      }
      references.push(reference);
    }
    const block = JSON.stringify({ uid: record.uid, name: record.name, aliases: record.aliases, parent: record.parent,
      visibility: record.visibility, fields: record.fields, body: record.body, textLength: record.textLength,
      ...(record.textNextOffset !== undefined ? { textNextOffset: record.textNextOffset } : {}),
      fieldCount: record.childCount, references,
    });
    if (block.length > remaining) continue;
    blocks.push(block); remaining -= block.length;
  }
  return blocks.length ? `\n\nCanonical committed records (bulk text may be truncated; read more with knowledge):\n${blocks.join("\n")}` : "";
}

export async function runScribe(provider: LLMProvider, input: ScribeInput, fileIO: ScribeFileIO, model: string): Promise<ScribeResult> {
  const created: string[] = [], updated: string[] = [], entityDeltas: ScribeEntityDelta[] = [], removedSlugs: string[] = [];
  const store = await getCampaignKnowledge(input.campaignRoot, fileIO);
  const organization = (await store.outline()).filter((node) => node.kind === "collection").map(({ uid, parent, name, note }) => ({ uid, parent, name, ...(note ? { note } : {}) }));
  const prefetched = await buildPrefetchedEntityBlock(input.updates, undefined, input.campaignRoot, fileIO, input.homeDir);
  const result = await spawnSubagent(provider, {
    name: "scribe", model, visibility: "silent", systemPrompt: cacheSystemPrompt(loadPrompt("scribe", model)),
    maxTokens: getMaxOutput(model), tools: [...ENTITY_TOOLS, PLAYER_PROFILE_CONTRACT.definition],
    toolHandler: buildScribeToolHandler(fileIO, input.campaignRoot, input.sceneNumber, created, updated, entityDeltas, removedSlugs, input.homeDir),
    toolInputPolicies: { ...ENTITY_INPUT_POLICIES, player_profile: PLAYER_PROFILE_CONTRACT.policy as ToolInputPolicy }, cacheTools: true, maxToolRounds: 8,
  }, `Latest committed campaign organization (including empty collections and conventions):\n${JSON.stringify(organization)}${prefetched}\n\nProcess these narrative updates:\n${input.updates.map((update, i) => `[${i + 1}] (${update.visibility}) ${update.content}`).join("\n\n")}`);
  return { summary: result.text, created, updated, entityDeltas, removedSlugs, usage: result.usage };
}
