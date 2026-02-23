import type Anthropic from "@anthropic-ai/sdk";
import type { SubagentStreamCallback } from "../subagent.js";
import { spawnSubagent } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import type { CampaignRepo } from "../../tools/git/index.js";
import { queryCommitLog } from "../../tools/git/index.js";

/**
 * Context snapshot for OOC mode — captured when entering, restored when exiting.
 */
export interface OOCSnapshot {
  /** The UI variant that was active before OOC */
  previousVariant: string;
  /** The DM was mid-narration when OOC was triggered */
  wasMidNarration: boolean;
}

/**
 * Result from an OOC session.
 */
export interface OOCResult extends SubagentResult {
  /** Terse summary of what happened in OOC (for DM context) */
  summary: string;
  /** The snapshot to restore */
  snapshot: OOCSnapshot;
}

/**
 * Build the OOC system prompt with campaign-specific context.
 */
export function buildOOCPrompt(
  campaignName: string,
  systemRules?: string,
  characterSheet?: string,
): string {
  let prompt = loadPrompt("ooc-mode");

  if (campaignName) {
    prompt += `\n\nCampaign: ${campaignName}`;
  }

  if (systemRules) {
    prompt += `\n\nGame system rules:\n${systemRules}`;
  }

  if (characterSheet) {
    prompt += `\n\nActive character:\n${characterSheet}`;
  }

  return prompt;
}

/** Build OOC tool definitions (available when repo is provided). */
export function buildOOCTools(): Anthropic.Tool[] {
  return [
    {
      name: "get_commit_log",
      description: "List git snapshot commits for this campaign. Shows commit hash, type, message, and timestamp. Use to review game history for rollback or debugging.",
      input_schema: {
        type: "object" as const,
        properties: {
          depth: { type: "number", description: "Number of commits to retrieve (default 20, max 100)" },
          type: { type: "string", enum: ["auto", "scene", "session", "checkpoint", "character"], description: "Filter by commit type" },
          search: { type: "string", description: "Filter by message content (case-insensitive)" },
        },
        required: [],
      },
    },
  ];
}

/** Build OOC tool handler. */
export function buildOOCToolHandler(
  repo: CampaignRepo,
): (name: string, input: Record<string, unknown>) => Promise<{ content: string; is_error?: boolean }> {
  return async (name: string, input: Record<string, unknown>) => {
    try {
      switch (name) {
        case "get_commit_log": {
          const result = await queryCommitLog(repo, {
            depth: input.depth as number | undefined,
            type: input.type as string | undefined,
            search: input.search as string | undefined,
          });
          return { content: result };
        }
        default:
          return { content: `Unknown tool: ${name}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: msg, is_error: true };
    }
  };
}

/**
 * Enter OOC mode — spawn a Sonnet subagent that handles OOC conversation.
 * The subagent is player-facing (streams to TUI).
 *
 * Returns a terse summary for the DM when OOC ends.
 */
export async function enterOOC(
  client: Anthropic,
  playerMessage: string,
  options: {
    campaignName: string;
    systemRules?: string;
    characterSheet?: string;
    previousVariant: string;
    wasMidNarration?: boolean;
    repo?: CampaignRepo;
  },
  onStream?: SubagentStreamCallback,
): Promise<OOCResult> {
  const systemPrompt = buildOOCPrompt(
    options.campaignName,
    options.systemRules,
    options.characterSheet,
  );

  const snapshot: OOCSnapshot = {
    previousVariant: options.previousVariant,
    wasMidNarration: options.wasMidNarration ?? false,
  };

  const hasTools = !!options.repo;
  const tools = hasTools ? buildOOCTools() : undefined;
  const toolHandler = hasTools ? buildOOCToolHandler(options.repo!) : undefined;

  const result = await spawnSubagent(
    client,
    {
      name: "ooc",
      model: getModel("medium"),
      visibility: "player_facing",
      systemPrompt,
      maxTokens: hasTools ? TOKEN_LIMITS.SUBAGENT_LARGE : TOKEN_LIMITS.SUBAGENT_MEDIUM,
      ...(tools ? { tools } : {}),
      ...(toolHandler ? { toolHandler } : {}),
      maxToolRounds: hasTools ? 5 : undefined,
    },
    playerMessage,
    onStream,
  );

  // The subagent's response IS the OOC content.
  // We also need a terse summary for the DM.
  // For a single-exchange OOC, the response itself is sufficient.
  // For multi-exchange, we'd need a follow-up summarization.
  // For now, truncate to first sentence as the summary.
  const summary = extractSummary(result.text);

  return {
    ...result,
    summary,
    snapshot,
  };
}

/**
 * Extract a terse summary from OOC text — first sentence, max 100 chars.
 */
function extractSummary(text: string): string {
  const firstSentence = text.split(/[.!?]\s/)[0];
  if (!firstSentence) return "OOC discussion.";
  const trimmed = firstSentence.trim();
  if (trimmed.length > 100) return trimmed.slice(0, 97) + "...";
  return trimmed + ".";
}
