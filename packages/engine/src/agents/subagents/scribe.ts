import type { LLMProvider, NormalizedTool } from "../../providers/types.js";
import { spawnSubagent, cacheSystemPrompt } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { join, dirname } from "node:path";
import { campaignPaths, machinePaths } from "../../tools/filesystem/index.js";
import { parseFrontMatter, serializeEntity } from "../../tools/filesystem/index.js";
import { formatChangelogEntry } from "../../tools/filesystem/index.js";
import type { EntityFrontMatter, EntityTree } from "@machine-violet/shared/types/entities.js";
import { renderEntityTree } from "../../tools/filesystem/index.js";
import { norm } from "../../utils/paths.js";

// Re-export slugify from world-builder so the game engine doesn't need a separate import
export { slugify } from "../world-builder.js";
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
  /** Usage stats */
  usage: UsageStats;
}

/** Abstraction for file I/O so tests can inject mocks */
export interface ScribeFileIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
}

// --- Scribe Tools (given to the subagent) ---

const SCRIBE_TOOLS: NormalizedTool[] = [
  {
    name: "list_entities",
    description: "List all entity files of a given type. Returns filenames (without extension).",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity_type: {
          type: "string",
          enum: ["character", "location", "faction", "lore", "item", "player"],
          description: "Entity type to list",
        },
      },
      required: ["entity_type"],
    },
  },
  {
    name: "read_entity",
    description: "Read an entity file's current contents. Returns the full markdown.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity_type: {
          type: "string",
          enum: ["character", "location", "faction", "lore", "item", "player"],
          description: "Entity type",
        },
        slug: {
          type: "string",
          description: "Entity slug (lowercase, hyphenated)",
        },
      },
      required: ["entity_type", "slug"],
    },
  },
  {
    name: "write_entity",
    description: "Create or update an entity file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["create", "update"],
          description: "Create a new entity or update an existing one",
        },
        entity_type: {
          type: "string",
          enum: ["character", "location", "faction", "lore", "item", "player"],
          description: "Entity type",
        },
        name: {
          type: "string",
          description: "Entity display name",
        },
        front_matter: {
          type: "object",
          description: "Front matter key-value pairs (for create: full set; for update: only changed keys, null deletes)",
        },
        body: {
          type: "string",
          description: "For create: full body. For update: sections to add or replace. If the text contains ## headings that already exist in the file, those sections are replaced in-place; new sections are appended. Omit to leave body unchanged.",
        },
        changelog_entry: {
          type: "string",
          description: "Changelog entry to add (terse, one line). Scene number added automatically.",
        },
      },
      required: ["mode", "entity_type", "name"],
    },
  },
];

/**
 * Fix literal `\n` sequences that LLMs sometimes produce in JSON string values.
 * JSON parsers handle real `\n` escapes, but models occasionally double-escape
 * them, producing literal backslash-n in the parsed string.
 */
function unescapeNewlines(s: string): string {
  return s.replace(/\\n/g, "\n");
}

/** Heading pattern: a `## ` at the start of a line (not `###` or deeper). */
const H2_RE = /^## /m;

/**
 * Split a markdown body into sections keyed by `## Heading`.
 * Returns an array of { heading, content } where heading is the full
 * `## Foo` line (or "" for preamble text before the first heading).
 * Content includes the heading line itself.
 */
export function splitSections(body: string): { heading: string; content: string }[] {
  if (!H2_RE.test(body)) return [{ heading: "", content: body }];

  const sections: { heading: string; content: string }[] = [];
  const lines = body.split("\n");
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      if (current) sections.push({ heading: current.heading, content: current.lines.join("\n") });
      current = { heading: line, lines: [line] };
    } else {
      if (!current) {
        current = { heading: "", lines: [] };
      }
      current.lines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, content: current.lines.join("\n") });

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
  // plain-text updates like adding a paragraph of description).
  if (!H2_RE.test(incoming)) {
    return existing ? `${existing}\n\n${incoming}` : incoming;
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

// --- Tool Handler Factory ---

export function buildScribeToolHandler(
  fileIO: ScribeFileIO,
  campaignRoot: string,
  sceneNumber: number,
  created: string[],
  updated: string[],
  entityDeltas: ScribeEntityDelta[],
  homeDir?: string,
) {
  const paths = campaignPaths(campaignRoot);
  const mPaths = homeDir ? machinePaths(homeDir) : undefined;

  function entityPath(entityType: string, slug: string): string {
    switch (entityType) {
      case "character": return paths.character(slug);
      case "location": return paths.location(slug);
      case "faction": return paths.faction(slug);
      case "lore": return paths.lore(slug);
      case "item": return paths.item(slug);
      case "player":
        if (!mPaths) throw new Error("player entity type requires homeDir");
        return mPaths.player(slug);
      default: return paths.lore(slug);
    }
  }

  function entityDir(entityType: string): string {
    switch (entityType) {
      case "character": return join(campaignRoot, "characters");
      case "location": return join(campaignRoot, "locations");
      case "faction": return join(campaignRoot, "factions");
      case "lore": return join(campaignRoot, "lore");
      case "item": return join(campaignRoot, "items");
      case "player":
        if (!mPaths) throw new Error("player entity type requires homeDir");
        return mPaths.playersDir;
      default: return join(campaignRoot, "lore");
    }
  }

  return async (name: string, input: Record<string, unknown>): Promise<{ content: string; is_error?: boolean }> => {
    switch (name) {
      case "list_entities": {
        const entityType = input.entity_type as string;
        const dir = entityDir(entityType);
        try {
          const entries = await fileIO.listDir(dir);
          const names = entries
            .filter(e => e.endsWith(".md"))
            .map(e => e.replace(/\.md$/, ""));
          // For locations, list subdirectories instead
          if (entityType === "location") {
            const dirEntries = entries.filter(e => !e.includes("."));
            return { content: dirEntries.length > 0 ? dirEntries.join("\n") : "(none)" };
          }
          return { content: names.length > 0 ? names.join("\n") : "(none)" };
        } catch {
          return { content: "(directory not found — no entities of this type yet)" };
        }
      }

      case "read_entity": {
        const entityType = input.entity_type as string;
        const slug = input.slug as string;
        const filePath = norm(entityPath(entityType, slug));
        try {
          const content = await fileIO.readFile(filePath);
          return { content };
        } catch {
          return { content: `Entity not found: ${entityType}/${slug}`, is_error: true };
        }
      }

      case "write_entity": {
        const mode = input.mode as string;
        const entityType = input.entity_type as string;
        const entityName = input.name as string | undefined;
        if (!entityName) {
          return { content: "write_entity requires a 'name' field", is_error: true };
        }
        const slug = slugify(entityName);
        const filePath = norm(entityPath(entityType, slug));

        try {
          if (mode === "create") {
            // Check for duplicates
            if (await fileIO.exists(filePath)) {
              return { content: `Entity already exists at ${filePath}. Use mode: "update" instead.`, is_error: true };
            }

            // Ensure parent directory exists
            await fileIO.mkdir(dirname(filePath));

            const fm: EntityFrontMatter = {
              type: entityType,
              ...(input.front_matter as Record<string, unknown> ?? {}),
            };
            const body = input.body ? unescapeNewlines(input.body as string) : "";
            const changelog: string[] = [];
            if (input.changelog_entry) {
              changelog.push(formatChangelogEntry(sceneNumber, unescapeNewlines(input.changelog_entry as string)));
            }
            const content = serializeEntity(entityName, fm, body, changelog);
            await fileIO.writeFile(filePath, content);
            created.push(filePath);
            const aliasRaw = fm.additional_names as string | undefined;
            const aliases = aliasRaw ? aliasRaw.split(",").map((a) => a.trim()).filter(Boolean) : [];
            const relativePath = norm(filePath).replace(norm(campaignRoot) + "/", "");
            entityDeltas.push({ slug, name: entityName, aliases, type: entityType, path: relativePath });
            return { content: `Created ${entityType} "${entityName}" at ${filePath}` };
          } else {
            // Update mode
            if (!(await fileIO.exists(filePath))) {
              return { content: `Entity not found at ${filePath}. Use mode: "create" instead.`, is_error: true };
            }

            const raw = await fileIO.readFile(filePath);
            const { frontMatter, body, changelog } = parseFrontMatter(raw);
            const title = (frontMatter._title ?? entityName) as string;

            // Merge front matter
            const fmUpdates = input.front_matter as Record<string, unknown> | undefined;
            if (fmUpdates) {
              for (const [key, value] of Object.entries(fmUpdates)) {
                if (value === null) {
                  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                  delete frontMatter[key];
                } else {
                  frontMatter[key] = value;
                }
              }
            }

            // Merge body with section-aware replacement
            let newBody = body;
            if (input.body) {
              const incoming = unescapeNewlines(input.body as string);
              newBody = body ? mergeSectionBodies(body, incoming) : incoming;
            }

            // Add changelog
            const newChangelog = [...changelog];
            if (input.changelog_entry) {
              newChangelog.push(formatChangelogEntry(sceneNumber, unescapeNewlines(input.changelog_entry as string)));
            }

            const content = serializeEntity(title, frontMatter, newBody, newChangelog);
            await fileIO.writeFile(filePath, content);
            updated.push(filePath);
            const aliasRaw = frontMatter.additional_names as string | undefined;
            const aliases = aliasRaw ? aliasRaw.split(",").map((a) => a.trim()).filter(Boolean) : [];
            const relativePath = norm(filePath).replace(norm(campaignRoot) + "/", "");
            entityDeltas.push({ slug, name: title, aliases, type: entityType, path: relativePath });
            return { content: `Updated "${title}" at ${filePath}` };
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: `write_entity failed: ${msg}`, is_error: true };
        }
      }

      default:
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
  };
}

// --- Main Entry Point ---

/**
 * Spawn the Scribe subagent to process batched entity updates.
 * The scribe has tools to list, read, and write entity files.
 */
export async function runScribe(
  provider: LLMProvider,
  input: ScribeInput,
  fileIO: ScribeFileIO,
): Promise<ScribeResult> {
  const systemPrompt = cacheSystemPrompt(loadPrompt("scribe"));
  const created: string[] = [];
  const updated: string[] = [];
  const entityDeltas: ScribeEntityDelta[] = [];

  const toolHandler = buildScribeToolHandler(
    fileIO,
    input.campaignRoot,
    input.sceneNumber,
    created,
    updated,
    entityDeltas,
    input.homeDir,
  );

  // Format the user message with all updates
  const updateLines = input.updates.map((u, i) =>
    `[${i + 1}] (${u.visibility}) ${u.content}`,
  ).join("\n\n");

  // Include entity tree so the Scribe can resolve existing entities before creating
  const treeRendered = input.entityTree ? renderEntityTree(input.entityTree) : undefined;
  const treeContext = treeRendered ? `\n\nEntity registry (use to find existing entities before creating):\n${treeRendered}\n` : "";

  const userMessage = `Process these updates:${treeContext}\n\n${updateLines}`;

  const result: SubagentResult = await spawnSubagent(provider, {
    name: "scribe",
    model: getModel("small"),
    visibility: "silent",
    systemPrompt,
    maxTokens: 512,
    tools: SCRIBE_TOOLS,
    toolHandler,
    cacheTools: true,
    maxToolRounds: 8,
  }, userMessage);

  return {
    summary: result.text,
    created,
    updated,
    entityDeltas,
    usage: result.usage,
  };
}
