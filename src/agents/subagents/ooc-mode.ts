import type Anthropic from "@anthropic-ai/sdk";
import type { SubagentStreamCallback } from "../subagent.js";
import { spawnSubagent } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";

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

const OOC_SYSTEM_PROMPT = `You are the Out-of-Character (OOC) assistant for a tabletop RPG session.

You help the player with questions and requests that are outside the game narrative:
- Rules questions ("How does grappling work?")
- Character sheet review ("What are my spell slots?")
- Campaign notes ("What happened in the last session?")
- Game settings ("Can we change the difficulty?")
- Meta-game discussion ("Is this fight balanced?")

You have access to the campaign's entity files and rules. Be helpful and concise.
Do NOT narrate game events or play the DM role.
When the player is done, summarize what was discussed in one terse sentence for the DM's context.`;

/**
 * Build the OOC system prompt with campaign-specific context.
 */
export function buildOOCPrompt(
  campaignName: string,
  systemRules?: string,
  characterSheet?: string,
): string {
  let prompt = OOC_SYSTEM_PROMPT;

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

  const result = await spawnSubagent(
    client,
    {
      name: "ooc",
      model: getModel("medium"),
      visibility: "player_facing",
      systemPrompt,
      maxTokens: TOKEN_LIMITS.SUBAGENT_MEDIUM,
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
