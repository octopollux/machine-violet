import type Anthropic from "@anthropic-ai/sdk";
import { spawnSubagent } from "../subagent.js";
import type { SubagentResult, SubagentStreamCallback } from "../subagent.js";
import { rollDice } from "../../tools/dice/index.js";
import type { RollDiceInput } from "../../types/dice.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

const SYSTEM_PROMPT = loadPrompt("resolve-action");

export interface ResolveActionInput {
  actor: string;
  action: string;
  target?: string;
  conditions?: string;
  actorSheet: string;
  targetStats?: string;
  rulesRef?: string;
}

/**
 * Resolution subagent.
 * Handles all mechanical resolution — attacks, skill checks, saves, ability uses.
 * Can call roll_dice as a tool. Player-facing when input is needed.
 *
 * @param client - Anthropic client
 * @param input - Action details + character sheets
 * @param onStream - Optional stream callback for player-facing mode
 * @returns Terse resolution result (~20-50 tokens)
 */
export async function resolveAction(
  client: Anthropic,
  input: ResolveActionInput,
  onStream?: SubagentStreamCallback,
): Promise<SubagentResult> {
  const prompt = buildPrompt(input);

  return spawnSubagent(
    client,
    {
      name: "resolve_action",
      model: getModel("small"),
      visibility: onStream ? "player_facing" : "silent",
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: TOKEN_LIMITS.SUBAGENT_SMALL,
      maxToolRounds: 3,
      tools: [ROLL_DICE_TOOL],
      toolHandler: (name, toolInput) => {
        if (name === "roll_dice") {
          const result = rollDice(toolInput as RollDiceInput);
          const lines = result.results.map((r) => {
            const kept = r.kept ? r.kept.join(",") : r.rolls.join(",");
            return `${r.expression}: [${kept}]→${r.total}`;
          });
          return { content: lines.join("; ") };
        }
        return { content: "Unknown tool", is_error: true };
      },
    },
    prompt,
    onStream,
  );
}

function buildPrompt(input: ResolveActionInput): string {
  const lines = [
    `Actor: ${input.actor}`,
    `Action: ${input.action}`,
  ];
  if (input.target) lines.push(`Target: ${input.target}`);
  if (input.conditions) lines.push(`Conditions: ${input.conditions}`);
  lines.push("", "Actor's sheet:", input.actorSheet);
  if (input.targetStats) lines.push("", "Target stats:", input.targetStats);
  if (input.rulesRef) lines.push("", "Rules reference:", input.rulesRef);
  lines.push("", "Resolve this action. Call roll_dice for any needed rolls.");
  return lines.join("\n");
}

const ROLL_DICE_TOOL: Anthropic.Tool = {
  name: "roll_dice",
  description: "Roll dice using standard notation. Returns individual rolls and total.",
  input_schema: {
    type: "object" as const,
    properties: {
      expression: { type: "string", description: "Dice notation, e.g. '1d20+5'" },
      reason: { type: "string", description: "Why this roll is being made" },
    },
    required: ["expression"],
  },
};
