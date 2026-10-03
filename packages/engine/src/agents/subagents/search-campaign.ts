import type { LLMProvider, NormalizedTool } from "../../providers/types.js";
import { spawnSubagent, cacheSystemPrompt } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getMaxOutput } from "../../config/model-registry.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import type { FileIO } from "../scene-manager.js";
import { walkCampaignFiles } from "../../tools/campaign-ops/walk-campaign.js";
import type { CampaignFile } from "../../tools/campaign-ops/walk-campaign.js";
import type { ToolInputPolicy } from "../tool-contract.js";
import { norm } from "../../utils/paths.js";
import { getCampaignKnowledge } from "../../knowledge/store.js";
import { KNOWLEDGE_CONTRACT, buildKnowledgeToolHandler } from "../../entities/tools.js";

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

const SEARCH_TOOLS: NormalizedTool[] = [
  KNOWLEDGE_CONTRACT.definition,
  {
    name: "grep_campaign",
    description: "Search all campaign files for a pattern (case-insensitive). Returns matching lines with file path and line number context. Use this first to find relevant content.",
    inputSchema: {
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
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Narrative path (campaign/scenes/... or rules/...) or knowledge:UID",
        },
      },
      required: ["path"],
    },
  },
];

// --- Tool handler factory ---

/** Allowlisted top-level directories — matches what walkCampaignFiles reads. */
const ALLOWED_PREFIXES = ["campaign/", "rules/"];

function isAllowedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  // Block dotfile directories (.debug/, .dev-mode/) and state/
  if (normalized.split("/").some((part) => part === "." || part === "..") || normalized.startsWith(".") || normalized.startsWith("state/")) return false;
  return ALLOWED_PREFIXES.some((p) => normalized.startsWith(p));
}

function matchesFilter(relativePath: string, filter: string): boolean {
  switch (filter) {
    case "entities":
      return false; // Logical entities are searched through knowledge.
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
    const store = await getCampaignKnowledge(campaignRoot, fileIO);
    const knowledge = buildKnowledgeToolHandler(store);
    if (name === "knowledge") return (await knowledge(name, input)) ?? { content: "Unknown knowledge tool", is_error: true };
    switch (name) {
      case "grep_campaign": {
        const pattern = input.pattern as string;
        const filter = (input.file_filter as string) || "all";
        const matches = grepFiles(files, pattern, filter);
        const logical = filter === "all" || filter === "entities" ? await knowledge("knowledge", { action: "search", query: pattern }) : null;
        const records = logical && !logical.is_error ? JSON.parse(logical.content) as { uid: string; name: string; owner?: { uid: string; name: string } }[] : [];

        if (matches.length === 0 && records.length === 0) {
          return { content: "No matches found." };
        }

        const lines = matches.map(
          (m) => `${m.file}:${m.line}: ${m.text}`,
        );
        lines.push(...records.slice(0, 30).map((record) => `knowledge:${record.uid}: ${record.owner ? `${record.owner.name} / ` : ""}${record.name}`));
        const suffix =
          matches.length >= 30 ? "\n(results truncated at 30 matches)" : "";
        return { content: lines.join("\n") + suffix };
      }

      case "read_campaign_file": {
        const relPath = input.path as string;
        if (relPath.startsWith("knowledge:")) return (await knowledge("knowledge", { action: "read", handle: relPath })) ?? { content: "Knowledge handler unavailable", is_error: true };
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
  provider: LLMProvider,
  input: SearchCampaignInput,
  fileIO: FileIO,
  model: string,
): Promise<SearchCampaignResult> {
  const systemPrompt = cacheSystemPrompt(loadPrompt("search-campaign", model));

  // Walk all files once — the subagent's grep tool searches this in-memory snapshot
  const files = await walkCampaignFiles(input.campaignRoot, fileIO);

  const toolHandler = buildSearchToolHandler(
    files,
    fileIO,
    input.campaignRoot,
  );

  const result: SubagentResult = await spawnSubagent(provider, {
    name: "search_campaign",
    model,
    visibility: "silent",
    systemPrompt,
    maxTokens: getMaxOutput(model),
    tools: SEARCH_TOOLS,
    toolHandler,
    toolInputPolicies: {
      knowledge: KNOWLEDGE_CONTRACT.policy as ToolInputPolicy,
      grep_campaign: { criticality: "advisory" },
      read_campaign_file: { criticality: "advisory" },
    },
    cacheTools: true,
    maxToolRounds: 5,
  }, `Search query: ${input.query}`);

  return {
    text: result.text,
    usage: result.usage,
  };
}
