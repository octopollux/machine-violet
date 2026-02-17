import type Anthropic from "@anthropic-ai/sdk";
import type { PlayerConfig } from "../../types/config.js";
import type { UsageStats } from "../agent-loop.js";
import { oneShot } from "../subagent.js";
import { getModel } from "../../config/models.js";

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
export interface AIPlayerResult {
  /** The in-character action text */
  action: string;
  /** Usage stats for this call */
  usage: UsageStats;
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

  return `You are ${player.character}, a character in a tabletop RPG.${personality}

Character sheet:
${characterSheet}${situationBlock}

Rules:
- Respond in character. Say what you do, concisely (1-2 sentences).
- You may include brief dialogue.
- Do NOT narrate outcomes — the DM handles that. Say "I try to pick the lock", not "I pick the lock and it opens."
- Do NOT use action tags like *asterisks* — just state your action plainly.
- Stay in character. Your personality drives your decisions.`;
}

/**
 * Invoke the AI player to generate their turn action.
 * Uses the player's configured model (default: Haiku for cost efficiency).
 */
export async function aiPlayerTurn(
  client: Anthropic,
  ctx: AIPlayerContext,
): Promise<AIPlayerResult> {
  const lookup = MODEL_MAP[ctx.player.model ?? "haiku"] ?? MODEL_MAP.haiku;
  const model = lookup();
  const systemPrompt = buildAIPlayerPrompt(ctx);

  const userMessage = ctx.recentNarration || "It's your turn. What do you do?";

  const result = await oneShot(
    client,
    model,
    systemPrompt,
    userMessage,
    150, // AI players should be brief
  );

  return {
    action: result.text.trim(),
    usage: result.usage,
  };
}
