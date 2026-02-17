/**
 * Character promotion/level-up subagent.
 * Reads character sheet + rules, generates updated character file.
 * Preserves changelog. Player-facing for interactive decisions.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SubagentStreamCallback } from "../subagent.js";
import { spawnSubagent } from "../subagent.js";
import type { UsageStats } from "../agent-loop.js";
import { getModel } from "../../config/models.js";

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

export interface PromotionResult {
  /** Updated character file content */
  updatedSheet: string;
  /** Changelog entry for this promotion */
  changelogEntry: string;
  /** Usage stats */
  usage: UsageStats;
}

const SYSTEM_PROMPT = `You are a character sheet manager for a tabletop RPG.

Given a character sheet, game rules, and promotion context, update the character sheet.
Apply level-up changes: new abilities, stat increases, HP changes, spell slots, etc.
Follow the game system's rules precisely. If no system rules are provided, make reasonable narrative-appropriate changes.

Output format:
1. First, output the COMPLETE updated character sheet (preserve the full markdown format including title and front matter).
2. Then, after a line containing only "---CHANGELOG---", output a single terse changelog line describing what changed.

Example changelog: "Level 5: +1 STR (16), Extra Attack, +5 HP (max 42)"`;

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
      maxTokens: 1024,
    },
    userMessage,
    onStream,
  );

  // Parse the response: sheet before ---CHANGELOG---, entry after
  const parts = result.text.split("---CHANGELOG---");
  const updatedSheet = (parts[0] ?? "").trim();
  const changelogEntry = (parts[1] ?? "Character promoted.").trim();

  return {
    updatedSheet,
    changelogEntry,
    usage: result.usage,
  };
}
