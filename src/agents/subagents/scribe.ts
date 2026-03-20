import Anthropic from "@anthropic-ai/sdk";
import { spawnSubagent, cacheSystemPrompt } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { join, dirname } from "node:path";
import { campaignPaths } from "../../tools/filesystem/index.js";
import { parseFrontMatter, serializeEntity } from "../../tools/filesystem/index.js";
import { formatChangelogEntry } from "../../tools/filesystem/index.js";
import type { EntityFrontMatter } from "../../types/entities.js";
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
}

export interface ScribeResult {
  /** Terse summary of what was written */
  summary: string;
  /** Entities created (file paths) */
  created: string[];
  /** Entities updated (file paths) */
  updated: string[];
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

const SCRIBE_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_entities",
    description: "List all entity files of a given type. Returns filenames (without extension).",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_type: {
          type: "string",
          enum: ["character", "location", "faction", "lore"],
          description: "Entity type to list",
        },
      },
      required: ["entity_type"],
    },
  },
  {
    name: "read_entity",
    description: "Read an entity file's current contents. Returns the full markdown.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_type: {
          type: "string",
          enum: ["character", "location", "faction", "lore"],
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
    input_schema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["create", "update"],
          description: "Create a new entity or update an existing one",
        },
        entity_type: {
          type: "string",
          enum: ["character", "location", "faction", "lore"],
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
          description: "For create: full body. For update: text to append (omit to leave body unchanged).",
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

// --- Tool Handler Factory ---

export function buildScribeToolHandler(
  fileIO: ScribeFileIO,
  campaignRoot: string,
  sceneNumber: number,
  created: string[],
  updated: string[],
) {
  const paths = campaignPaths(campaignRoot);

  function entityPath(entityType: string, slug: string): string {
    switch (entityType) {
      case "character": return paths.character(slug);
      case "location": return paths.location(slug);
      case "faction": return paths.faction(slug);
      case "lore": return paths.lore(slug);
      default: return paths.lore(slug);
    }
  }

  function entityDir(entityType: string): string {
    switch (entityType) {
      case "character": return join(campaignRoot, "characters");
      case "location": return join(campaignRoot, "locations");
      case "faction": return join(campaignRoot, "factions");
      case "lore": return join(campaignRoot, "lore");
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

            // Append body
            let newBody = body;
            if (input.body) {
              const appended = unescapeNewlines(input.body as string);
              newBody = body ? `${body}\n\n${appended}` : appended;
            }

            // Add changelog
            const newChangelog = [...changelog];
            if (input.changelog_entry) {
              newChangelog.push(formatChangelogEntry(sceneNumber, unescapeNewlines(input.changelog_entry as string)));
            }

            const content = serializeEntity(title, frontMatter, newBody, newChangelog);
            await fileIO.writeFile(filePath, content);
            updated.push(filePath);
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
  client: Anthropic,
  input: ScribeInput,
  fileIO: ScribeFileIO,
): Promise<ScribeResult> {
  const systemPrompt = cacheSystemPrompt(loadPrompt("scribe"));
  const created: string[] = [];
  const updated: string[] = [];

  const toolHandler = buildScribeToolHandler(
    fileIO,
    input.campaignRoot,
    input.sceneNumber,
    created,
    updated,
  );

  // Format the user message with all updates
  const updateLines = input.updates.map((u, i) =>
    `[${i + 1}] (${u.visibility}) ${u.content}`,
  ).join("\n\n");

  const userMessage = `Process these updates:\n\n${updateLines}`;

  const result: SubagentResult = await spawnSubagent(client, {
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
    usage: result.usage,
  };
}
