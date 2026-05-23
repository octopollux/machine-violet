import type { LLMProvider, NormalizedTool } from "../../providers/types.js";
import { spawnSubagent, cacheSystemPrompt } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getMaxOutput } from "../../config/model-registry.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { dirname } from "node:path";
import { machinePaths } from "../../tools/filesystem/index.js";
import { parseFrontMatter, serializeEntity } from "../../tools/filesystem/index.js";
import { formatChangelogEntry } from "../../tools/filesystem/index.js";
import type { EntityFrontMatter, EntityTree } from "@machine-violet/shared/types/entities.js";
import { renderEntityTree } from "../../tools/filesystem/index.js";
import { norm } from "../../utils/paths.js";
import { renameEntity as renameEntityOp } from "../../tools/campaign-ops/rename-entity.js";
import { EntityStore } from "../../entities/store.js";
import { isFileBackedEntityType } from "@machine-violet/shared/schemas/entities/index.js";
import type { FileIO } from "../scene-manager.js";

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
  /** Slugs to remove from the entity tree (e.g. after a rename). */
  removedSlugs: string[];
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
  /** Optional. Required for `rename_entity`. */
  deleteFile?(path: string): Promise<void>;
  /** Optional. Used by `rename_entity` to clean up an emptied location dir. */
  rmdir?(path: string): Promise<void>;
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
  {
    name: "rename_entity",
    description:
      "Rename an existing entity. Moves the file to the new slug, updates its H1 to the new display name, and rewrites every wikilink across the campaign that pointed to the old entity. Use this when an entity is renamed in fiction (e.g. a tavern reveals its real name) — and especially to replace the placeholder `Starting Location` once the opening locale has a real name. Player entities are machine-scope and not renamable through this tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entity_type: {
          type: "string",
          enum: ["character", "location", "faction", "lore", "item"],
          description: "Entity type. `player` is intentionally excluded — player files are machine-scope.",
        },
        old_name: {
          type: "string",
          description: "Current display name of the entity (e.g. \"Starting Location\"). Used to derive the existing slug.",
        },
        new_name: {
          type: "string",
          description: "New display name (e.g. \"The Crooked Coin Tavern\"). The new slug is derived from this name.",
        },
        changelog_entry: {
          type: "string",
          description: "Optional changelog entry. If omitted, a default \"Renamed from X to Y\" entry is added.",
        },
      },
      required: ["entity_type", "old_name", "new_name"],
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

/**
 * Repair front_matter objects produced by smaller models (gpt-5.4-mini in
 * particular) that occasionally pass the entire on-disk markdown line as
 * the JSON key — e.g. `{ "**Type:** character": "character" }` — instead of
 * the documented `{ "type": "character" }` shape. Without this, the
 * serializer round-trips the bad key as `****Type:** character:** character`
 * and the file frontmatter is permanently corrupted on subsequent reads.
 *
 * Strategy: detect a `**Key:**` prefix in the key, extract the real key
 * (lowercased + snake-cased to match {@link normalizeKey}), and use the
 * trailing fragment as the value if no separate value was supplied or if
 * the supplied value duplicates the trailing fragment.
 */
export function sanitizeFrontMatter(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const KEY_RE = /^\*+\s*([^*:]+?)\s*:\*+\s*(.*)$/;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const m = KEY_RE.exec(rawKey);
    if (!m) {
      out[rawKey] = rawValue;
      continue;
    }
    const recoveredKey = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    const recoveredValueFromKey = m[2].trim();
    // `null` is the deletion sentinel — preserve it regardless of any
    // value fragment recovered from the malformed key. Otherwise a
    // payload like `{ "**Location:** [[Old]]": null }` would silently
    // become `{ location: "[[Old]]" }` and never actually delete the
    // field (Copilot-flagged regression on #481).
    const value =
      rawValue === null
        ? null
        : typeof rawValue === "string" && rawValue.trim() && rawValue.trim() !== recoveredValueFromKey
          ? rawValue
          : recoveredValueFromKey || rawValue;
    if (!(recoveredKey in out)) {
      out[recoveredKey] = value;
    }
  }
  return out;
}

/** Heading pattern: a `## ` at the start of a line (not `###` or deeper). */
const H2_RE = /^## (?!#)/m;

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
  removedSlugs: string[] = [],
  homeDir?: string,
) {
  const mPaths = homeDir ? machinePaths(homeDir) : undefined;
  // EntityStore owns disk I/O for the five file-backed types. Scribe still
  // handles `player` itself because players are machine-scope, not
  // campaign-scope, and don't fit the store's campaign-rooted model.
  const store = new EntityStore(campaignRoot, fileIO);

  function playerPath(slug: string): string {
    if (!mPaths) throw new Error("player entity type requires homeDir");
    return mPaths.player(slug);
  }

  function entityPath(entityType: string, slug: string): string {
    if (isFileBackedEntityType(entityType)) {
      return store.pathFor(entityType, slug).abs;
    }
    if (entityType === "player") return playerPath(slug);
    // Unknown type — fall back to lore for back-compat with prior behavior.
    return store.pathFor("lore", slug).abs;
  }

  function entityDir(entityType: string): string {
    if (isFileBackedEntityType(entityType)) return store.dirFor(entityType);
    if (entityType === "player") {
      if (!mPaths) throw new Error("player entity type requires homeDir");
      return mPaths.playersDir;
    }
    return store.dirFor("lore");
  }

  return async (name: string, input: Record<string, unknown>): Promise<{ content: string; is_error?: boolean }> => {
    switch (name) {
      case "list_entities": {
        const entityType = input.entity_type as string;
        const dir = entityDir(entityType);
        // Probe the directory directly so we can distinguish "no entities of
        // this type yet" (dir doesn't exist) from "dir exists but is empty"
        // — the prompt relies on the wording. For file-backed types, route
        // the actual enumeration through the store so the location-subdir
        // quirk + skip-files behaviour is unified.
        try {
          await fileIO.listDir(dir);
        } catch {
          return { content: "(directory not found — no entities of this type yet)" };
        }
        if (isFileBackedEntityType(entityType)) {
          const entries = await store.list(entityType);
          return { content: entries.length > 0 ? entries.map(e => e.id).join("\n") : "(none)" };
        }
        // Player (machine-scope) — flat .md listing.
        const entries = await fileIO.listDir(dir);
        const names = entries
          .filter(e => e.endsWith(".md"))
          .map(e => e.replace(/\.md$/, ""));
        return { content: names.length > 0 ? names.join("\n") : "(none)" };
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
              ...sanitizeFrontMatter((input.front_matter as Record<string, unknown> | undefined) ?? {}),
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

            // Merge front matter (sanitize first to catch small-model
            // mistakes that pass full `**Key:** Value` markdown lines as
            // JSON keys — see sanitizeFrontMatter).
            const fmUpdates = input.front_matter as Record<string, unknown> | undefined;
            if (fmUpdates) {
              for (const [key, value] of Object.entries(sanitizeFrontMatter(fmUpdates))) {
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

      case "rename_entity": {
        const entityType = input.entity_type as string;
        const oldName = input.old_name as string;
        const newName = input.new_name as string;
        if (!oldName || !newName) {
          return { content: "rename_entity requires 'old_name' and 'new_name'", is_error: true };
        }
        // Player entities live under homeDir, not campaignRoot — renaming them
        // would mean retargeting every campaign that knows the player.
        // Out of scope for an in-campaign Scribe.
        if (entityType === "player") {
          return { content: "rename_entity does not support player entities (machine-scope, not campaign-scope)", is_error: true };
        }
        const oldSlug = slugify(oldName);
        const newSlug = slugify(newName);
        if (oldSlug === newSlug) {
          return { content: `Old and new names slugify to the same value (${oldSlug}); nothing to rename`, is_error: true };
        }
        if (!fileIO.deleteFile) {
          return { content: "rename_entity requires file deletion support, which is unavailable in this environment", is_error: true };
        }

        const oldFilePath = norm(entityPath(entityType, oldSlug));
        const newFilePath = norm(entityPath(entityType, newSlug));
        // Defense in depth: refuse anything that didn't resolve under campaignRoot.
        // Catches future bugs where a new entity type lands outside the campaign tree.
        const normRoot = norm(campaignRoot);
        if (!oldFilePath.startsWith(normRoot + "/") || !newFilePath.startsWith(normRoot + "/")) {
          return { content: `rename_entity refused: ${entityType} resolves outside the campaign root`, is_error: true };
        }
        if (!(await fileIO.exists(oldFilePath))) {
          return { content: `Entity not found: ${entityType}/${oldSlug}`, is_error: true };
        }
        if (await fileIO.exists(newFilePath)) {
          return { content: `Cannot rename: ${entityType}/${newSlug} already exists`, is_error: true };
        }

        const oldRelative = oldFilePath.slice(normRoot.length + 1);
        const newRelative = newFilePath.slice(normRoot.length + 1);

        try {
          // Move the file and rewrite incoming wikilinks campaign-wide.
          // ScribeFileIO is a structural subset of the FileIO that
          // renameEntity needs; deleteFile is the only optional method
          // it touches and we already checked it above.
          const renameResult = await renameEntityOp(
            campaignRoot,
            fileIO as FileIO,
            oldRelative,
            newRelative,
            false,
          );

          // Update the H1 to the new display name and add a changelog entry.
          const moved = await fileIO.readFile(newFilePath);
          const { frontMatter, body, changelog } = parseFrontMatter(moved);
          const entry = (input.changelog_entry as string | undefined)?.trim()
            || `Renamed from ${oldName} to ${newName}`;
          const updatedChangelog = [
            ...changelog,
            formatChangelogEntry(sceneNumber, unescapeNewlines(entry)),
          ];
          const finalContent = serializeEntity(newName, frontMatter, body, updatedChangelog);
          await fileIO.writeFile(newFilePath, finalContent);

          // Best-effort: remove the now-empty location subdirectory.
          if (entityType === "location" && fileIO.rmdir) {
            const oldDir = oldFilePath.replace(/\/index\.md$/, "");
            try {
              await fileIO.rmdir(oldDir);
            } catch {
              // Directory may still contain map JSONs — leave it.
            }
          }

          // Track tree changes and updated-file list.
          const aliasRaw = frontMatter.additional_names as string | undefined;
          const aliases = aliasRaw ? aliasRaw.split(",").map(a => a.trim()).filter(Boolean) : [];
          entityDeltas.push({ slug: newSlug, name: newName, aliases, type: entityType, path: newRelative });
          removedSlugs.push(oldSlug);
          updated.push(newFilePath);

          const fileWord = renameResult.filesUpdated.length === 1 ? "file" : "files";
          const linkWord = renameResult.linksUpdated === 1 ? "link" : "links";
          return {
            content: `Renamed ${entityType} "${oldName}" -> "${newName}". Rewrote ${renameResult.linksUpdated} ${linkWord} across ${renameResult.filesUpdated.length} ${fileWord}.`,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: `rename_entity failed: ${msg}`, is_error: true };
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
  model: string,
): Promise<ScribeResult> {
  const systemPrompt = cacheSystemPrompt(loadPrompt("scribe", model));
  const created: string[] = [];
  const updated: string[] = [];
  const entityDeltas: ScribeEntityDelta[] = [];
  const removedSlugs: string[] = [];

  const toolHandler = buildScribeToolHandler(
    fileIO,
    input.campaignRoot,
    input.sceneNumber,
    created,
    updated,
    entityDeltas,
    removedSlugs,
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
    model,
    visibility: "silent",
    systemPrompt,
    maxTokens: getMaxOutput(model),
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
    removedSlugs,
    usage: result.usage,
  };
}
