/**
 * Character promotion/level-up subagent.
 * Reads character sheet + rules, generates updated character file.
 * Preserves changelog. Player-facing for interactive decisions.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SubagentStreamCallback } from "../subagent.js";
import { spawnSubagent } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

export interface PromotionInput {
  /** Current character file content (markdown with front matter) */
  characterSheet: string;
  /** Game system rules relevant to leveling (optional) */
  systemRules?: string;
  /** DM context about the promotion (e.g., "Aldric reached level 5 after defeating the dragon") */
  context: string;
  /** Character name */
  characterName: string;
}

export interface PromotionResult extends SubagentResult {
  /** Updated character file content */
  updatedSheet: string;
  /** Changelog entry for this promotion */
  changelogEntry: string;
}

const SYSTEM_PROMPT = loadPrompt("character-promotion");

/**
 * Run the character promotion subagent.
 * Player-facing so the player can see and interact with choices.
 */
export async function promoteCharacter(
  client: Anthropic,
  input: PromotionInput,
  onStream?: SubagentStreamCallback,
): Promise<PromotionResult> {
  const rulesBlock = input.systemRules
    ? `\n\nGame system rules:\n${input.systemRules}`
    : "";

  const systemPrompt = SYSTEM_PROMPT + rulesBlock;

  const userMessage = `Character: ${input.characterName}
Context: ${input.context}

Current character sheet:
${input.characterSheet}`;

  const result = await spawnSubagent(
    client,
    {
      name: "promote_character",
      model: getModel("small"),
      visibility: onStream ? "player_facing" : "silent",
      systemPrompt,
      maxTokens: TOKEN_LIMITS.SUBAGENT_LARGE,
    },
    userMessage,
    onStream,
  );

  // Parse the response: sheet before ---CHANGELOG---, entry after
  const parts = result.text.split("---CHANGELOG---");
  const updatedSheet = (parts[0] ?? "").trim();
  const changelogEntry = (parts[1] ?? "Character promoted.").trim();

  return {
    ...result,
    updatedSheet,
    changelogEntry,
  };
}
