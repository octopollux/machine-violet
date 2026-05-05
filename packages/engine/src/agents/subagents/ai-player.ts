import type { LLMProvider } from "../../providers/types.js";
import type { PlayerConfig } from "@machine-violet/shared/types/config.js";
import { spawnSubagent } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { loadTemplate } from "../../prompts/load-prompt.js";

/**
 * Context provided to the AI player for decision-making.
 */
export interface AIPlayerContext {
  /** The player configuration (personality, model, etc.) */
  player: PlayerConfig;
  /** Character sheet summary (~100-200 tokens) */
  characterSheet: string;
  /** Recent DM narration (last 3-5 exchanges) */
  recentNarration: string;
  /** Current situation context (location, NPCs present, etc.) */
  situation?: string;
}

/**
 * Result from an AI player turn.
 */
export interface AIPlayerResult extends SubagentResult {
  /** The in-character action text */
  action: string;
}

const MODEL_MAP = {
  haiku: () => getModel("small"),
  sonnet: () => getModel("medium"),
} as const;

/**
 * Build the system prompt for an AI player.
 */
export function buildAIPlayerPrompt(ctx: AIPlayerContext): string {
  const { player, characterSheet, situation } = ctx;

  const personality = player.personality
    ? `\n\nPersonality: ${player.personality}`
    : "";

  const situationBlock = situation
    ? `\n\nCurrent situation: ${situation}`
    : "";

  return loadTemplate("ai-player", {
    characterName: player.character,
    personality,
    characterSheet,
    situation: situationBlock,
  });
}

/**
 * Invoke the AI player to generate their turn action.
 * Uses the player's configured model (default: Haiku for cost efficiency).
 */
export async function aiPlayerTurn(
  provider: LLMProvider,
  ctx: AIPlayerContext,
  model?: string,
): Promise<AIPlayerResult> {
  const lookup = MODEL_MAP[ctx.player.model ?? "haiku"] ?? MODEL_MAP.haiku;
  const resolvedModel = model ?? lookup();
  const systemPrompt = buildAIPlayerPrompt(ctx);

  const userMessage = ctx.recentNarration || "It's your turn. What do you do?";

  // AI player prompts are fully dynamic (character sheet + situation change every call),
  // so we skip system prompt caching to avoid paying the cache-write surcharge with no reuse.
  const result = await spawnSubagent(provider, {
    name: "ai-player",
    model: resolvedModel,
    visibility: "silent",
    systemPrompt,
    maxTokens: 150, // AI players should be brief
  }, userMessage);

  return {
    ...result,
    action: result.text.trim(),
  };
}
