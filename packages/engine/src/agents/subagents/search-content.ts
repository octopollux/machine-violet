import type { LLMProvider, NormalizedTool } from "../../providers/types.js";
import { spawnSubagent, cacheSystemPrompt } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import type { FileIO } from "../scene-manager.js";
import { processingPaths } from "../../config/processing-paths.js";
import type { CategoryFacets, EntityFacet } from "@machine-violet/shared/types/facets.js";

// --- Types ---

export interface SearchContentInput {
  query: string;
  systemSlug: string;
  homeDir: string;
}

export interface SearchContentResult {
  text: string;
  usage: UsageStats;
}

// --- Fraction parsing for CR values ---

/** Parse a value that might be a fraction (e.g. "1/4" → 0.25) or a number. */
function parseNumeric(value: string): number | null {
  const trimmed = value.trim();
  const fractionMatch = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fractionMatch) {
    const denom = Number(fractionMatch[2]);
    if (denom === 0) return null;
    return Number(fractionMatch[1]) / denom;
  }
  const n = Number(trimmed);
  return isNaN(n) ? null : n;
}

// --- Filter logic ---

interface FilterResult {
  matches: EntityFacet[];
  total: number;
}

function applyFilters(
  facets: CategoryFacets,
  filters: Record<string, string>,
  limit: number,
): FilterResult {
  const matches: EntityFacet[] = [];

  for (const entity of facets.entities) {
    let match = true;

    for (const [filterKey, filterValue] of Object.entries(filters)) {
      if (filterKey.startsWith("min_")) {
        const fieldKey = filterKey.slice(4);
        const entityVal = entity.fields[fieldKey];
        if (!entityVal) { match = false; break; }
        const numEntity = parseNumeric(entityVal);
        const numFilter = parseNumeric(filterValue);
        if (numEntity === null || numFilter === null || numEntity < numFilter) {
          match = false; break;
        }
      } else if (filterKey.startsWith("max_")) {
        const fieldKey = filterKey.slice(4);
        const entityVal = entity.fields[fieldKey];
        if (!entityVal) { match = false; break; }
        const numEntity = parseNumeric(entityVal);
        const numFilter = parseNumeric(filterValue);
        if (numEntity === null || numFilter === null || numEntity > numFilter) {
          match = false; break;
        }
      } else {
        // Substring match
        const entityVal = entity.fields[filterKey];
        if (!entityVal) { match = false; break; }
        if (!entityVal.toLowerCase().includes(filterValue.toLowerCase())) {
          match = false; break;
        }
      }
    }

    if (match) {
      matches.push(entity);
      if (matches.length >= limit) break;
    }
  }

  return { matches, total: matches.length };
}

// --- Search tools given to the subagent ---

const SEARCH_TOOLS: NormalizedTool[] = [
  {
    name: "list_categories",
    description: "List available entity categories in the game system content library.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "search_facets",
    description: "Search a category's faceted index. Filters support substring match on any field, and min_/max_ prefixes for numeric ranges (handles fractional CR like '1/4'). Returns matching entities with their key stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Category to search (e.g. 'monsters', 'spells')",
        },
        filters: {
          type: "object",
          description: "Key-value filters. Use field names for substring match, min_/max_ prefixed field names for numeric ranges. E.g. { \"type\": \"Dragon\", \"min_cr\": \"8\", \"max_cr\": \"12\" }",
          additionalProperties: { type: "string" },
        },
        limit: {
          type: "number",
          description: "Max results to return (default 20)",
        },
      },
      required: ["category", "filters"],
    },
  },
  {
    name: "read_entity",
    description: "Read the full markdown content of a specific entity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Entity category (e.g. 'monsters')",
        },
        slug: {
          type: "string",
          description: "Entity slug (filename without .md)",
        },
      },
      required: ["category", "slug"],
    },
  },
];

// --- Tool handler factory ---

export function buildContentSearchToolHandler(
  fileIO: FileIO,
  homeDir: string,
  systemSlug: string,
) {
  const paths = processingPaths(homeDir, systemSlug);

  // Cache loaded facets to avoid re-reading
  const facetsCache = new Map<string, CategoryFacets>();

  async function loadFacets(category: string): Promise<CategoryFacets | null> {
    const cached = facetsCache.get(category);
    if (cached) return cached;

    const facetsPath = paths.facets(category);
    try {
      const raw = await fileIO.readFile(facetsPath);
      const parsed = JSON.parse(raw) as CategoryFacets;
      facetsCache.set(category, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ content: string; is_error?: boolean }> => {
    switch (name) {
      case "list_categories": {
        try {
          if (!(await fileIO.exists(paths.entitiesDir))) {
            return { content: "No entities directory found for this system." };
          }
          const dirs = await fileIO.listDir(paths.entitiesDir);
          if (dirs.length === 0) {
            return { content: "No categories found." };
          }
          return { content: JSON.stringify(dirs) };
        } catch {
          return { content: "Failed to list categories.", is_error: true };
        }
      }

      case "search_facets": {
        const category = input.category as string;
        const filters = (input.filters as Record<string, string>) || {};
        const limit = (input.limit as number) || 20;

        const facets = await loadFacets(category);
        if (!facets) {
          return {
            content: `No facets index found for category '${category}'. Use list_categories to see available categories.`,
            is_error: true,
          };
        }

        const { matches } = applyFilters(facets, filters, limit);

        if (matches.length === 0) {
          return {
            content: `No entities match filters in '${category}'. Available fields: ${facets.fieldKeys.join(", ")}`,
          };
        }

        const results = matches.map((e) => ({
          slug: e.slug,
          name: e.name,
          ...e.fields,
        }));

        return { content: JSON.stringify(results, null, 2) };
      }

      case "read_entity": {
        const category = input.category as string;
        const slug = input.slug as string;
        const entityPath = paths.entityFile(category, slug);
        try {
          const content = await fileIO.readFile(entityPath);
          return { content };
        } catch {
          return {
            content: `Entity not found: ${category}/${slug}`,
            is_error: true,
          };
        }
      }

      default:
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
  };
}

// --- Main entry point ---

/**
 * Spawn a search subagent to find entities in a processed game system's content library.
 */
export async function searchContent(
  provider: LLMProvider,
  input: SearchContentInput,
  fileIO: FileIO,
): Promise<SearchContentResult> {
  const systemPrompt = cacheSystemPrompt(loadPrompt("search-content"));

  const toolHandler = buildContentSearchToolHandler(
    fileIO,
    input.homeDir,
    input.systemSlug,
  );

  const result: SubagentResult = await spawnSubagent(provider, {
    name: "search_content",
    model: getModel("small"),
    visibility: "silent",
    systemPrompt,
    maxTokens: 512,
    tools: SEARCH_TOOLS,
    toolHandler,
    cacheTools: true,
    maxToolRounds: 5,
  }, `Search query: ${input.query}`);

  return {
    text: result.text,
    usage: result.usage,
  };
}
