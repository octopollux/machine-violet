import Anthropic from "@anthropic-ai/sdk";
import { spawnSubagent } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import type { FileIO } from "../scene-manager.js";
import { walkCampaignFiles } from "../../tools/campaign-ops/walk-campaign.js";
import type { CampaignFile } from "../../tools/campaign-ops/walk-campaign.js";
import { norm } from "../../utils/paths.js";

// --- Types ---

export interface SearchCampaignInput {
  query: string;
  campaignRoot: string;
}

export interface SearchCampaignResult {
  /** Terse search results with wikilinks and source references */
  text: string;
  /** Usage stats */
  usage: UsageStats;
}

// --- Search tools given to the subagent ---

const SEARCH_TOOLS: Anthropic.Tool[] = [
  {
    name: "grep_campaign",
    description: "Search all campaign files for a pattern (case-insensitive). Returns matching lines with file path and line number context. Use this first to find relevant content.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern (case-insensitive substring match)",
        },
        file_filter: {
          type: "string",
          enum: ["all", "entities", "scenes", "recaps", "log"],
          description: "Limit search to a category. Default: all",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_campaign_file",
    description: "Read the full content of a specific campaign file by its relative path (as returned by grep_campaign).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path within the campaign, e.g. 'characters/kael.md'",
        },
      },
      required: ["path"],
    },
  },
];

// --- Tool handler factory ---

/** Allowlisted top-level directories — matches what walkCampaignFiles reads. */
const ALLOWED_PREFIXES = [
  "characters/",
  "locations/",
  "factions/",
  "lore/",
  "players/",
  "campaign/",
  "rules/",
];

function isAllowedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  // Block dotfile directories (.debug/, .dev-mode/) and state/
  if (normalized.startsWith(".") || normalized.startsWith("state/")) return false;
  return ALLOWED_PREFIXES.some((p) => normalized.startsWith(p));
}

function matchesFilter(relativePath: string, filter: string): boolean {
  switch (filter) {
    case "entities":
      return /^(characters|locations|factions|lore|players)\//.test(relativePath);
    case "scenes":
      return relativePath.startsWith("campaign/scenes/");
    case "recaps":
      return relativePath.startsWith("campaign/session-recaps/");
    case "log":
      return relativePath.startsWith("campaign/log");
    default:
      return true;
  }
}

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

function grepFiles(
  files: CampaignFile[],
  pattern: string,
  filter: string,
): GrepMatch[] {
  const lowerPattern = pattern.toLowerCase();
  const matches: GrepMatch[] = [];
  const MAX_MATCHES = 30;

  for (const file of files) {
    if (!matchesFilter(file.relativePath, filter)) continue;

    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lowerPattern)) {
        matches.push({
          file: file.relativePath,
          line: i + 1,
          text: lines[i].trim(),
        });
        if (matches.length >= MAX_MATCHES) return matches;
      }
    }
  }
  return matches;
}

export function buildSearchToolHandler(
  files: CampaignFile[],
  fileIO: FileIO,
  campaignRoot: string,
) {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ content: string; is_error?: boolean }> => {
    switch (name) {
      case "grep_campaign": {
        const pattern = input.pattern as string;
        const filter = (input.file_filter as string) || "all";
        const matches = grepFiles(files, pattern, filter);

        if (matches.length === 0) {
          return { content: "No matches found." };
        }

        const lines = matches.map(
          (m) => `${m.file}:${m.line}: ${m.text}`,
        );
        const suffix =
          matches.length >= 30 ? "\n(results truncated at 30 matches)" : "";
        return { content: lines.join("\n") + suffix };
      }

      case "read_campaign_file": {
        const relPath = input.path as string;
        if (!isAllowedPath(relPath)) {
          return {
            content: `Access denied: ${relPath} — only campaign content directories are searchable`,
            is_error: true,
          };
        }
        const absPath = norm(campaignRoot + "/" + relPath);
        try {
          const content = await fileIO.readFile(absPath);
          return { content };
        } catch {
          return {
            content: `File not found: ${relPath}`,
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
 * Spawn a search subagent to find information across the campaign.
 * Walks all campaign files once, then gives the subagent grep/read tools
 * to search and cross-reference.
 */
export async function searchCampaign(
  client: Anthropic,
  input: SearchCampaignInput,
  fileIO: FileIO,
): Promise<SearchCampaignResult> {
  const systemPrompt = loadPrompt("search-campaign");

  // Walk all files once — the subagent's grep tool searches this in-memory snapshot
  const files = await walkCampaignFiles(input.campaignRoot, fileIO);

  const toolHandler = buildSearchToolHandler(
    files,
    fileIO,
    input.campaignRoot,
  );

  const result: SubagentResult = await spawnSubagent(client, {
    name: "search_campaign",
    model: getModel("small"),
    visibility: "silent",
    systemPrompt,
    maxTokens: 512,
    tools: SEARCH_TOOLS,
    toolHandler,
    maxToolRounds: 5,
  }, `Search query: ${input.query}`);

  return {
    text: result.text,
    usage: result.usage,
  };
}
