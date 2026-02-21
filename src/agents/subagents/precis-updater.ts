import type Anthropic from "@anthropic-ai/sdk";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

/** Lightweight player sentiment/engagement signals extracted per exchange. */
export interface PlayerRead {
  engagement: "high" | "moderate" | "low";
  focus: string[];
  tone: string;
  pacing: "exploratory" | "pushing_forward" | "hesitant";
  offScript: boolean;
}

/** Extended result from updatePrecis that includes optional player read. */
export interface PrecisUpdateResult extends SubagentResult {
  playerRead?: PlayerRead;
}

const SYSTEM_PROMPT = loadPrompt("precis-updater");

/**
 * Precis updater subagent.
 * When an exchange drops from the DM's conversation window,
 * this appends a terse summary to the running scene precis
 * and extracts player sentiment signals.
 *
 * @param client - Anthropic client
 * @param currentPrecis - The current scene precis
 * @param droppedExchange - The exchange that was dropped (formatted as text)
 * @returns Updated precis text and optional player read
 */
export async function updatePrecis(
  client: Anthropic,
  currentPrecis: string,
  droppedExchange: string,
): Promise<PrecisUpdateResult> {
  const prompt = `Current precis:\n${currentPrecis}\n\nDropped exchange:\n${droppedExchange}\n\nAppend a terse summary of the dropped exchange to the precis, then add the PLAYER_READ: JSON line.`;

  const result = await oneShot(
    client,
    getModel("small"),
    SYSTEM_PROMPT,
    prompt,
    192,
  );

  return parsePrecisResult(result);
}

/**
 * Parse the subagent response into precis text and optional PlayerRead.
 * The model is expected to output:
 *   <precis text>
 *   PLAYER_READ: {"engagement":"high",...}
 *
 * If the PLAYER_READ line is missing or malformed, returns undefined playerRead.
 */
export function parsePrecisResult(result: SubagentResult): PrecisUpdateResult {
  const lines = result.text.split("\n");
  const playerReadIdx = lines.findIndex((l) => l.trim().startsWith("PLAYER_READ:"));

  if (playerReadIdx === -1) {
    return { ...result, playerRead: undefined };
  }

  const precisText = lines.slice(0, playerReadIdx).join("\n").trim();
  const jsonStr = lines[playerReadIdx].replace(/^.*?PLAYER_READ:\s*/, "");

  let playerRead: PlayerRead | undefined;
  try {
    const parsed = JSON.parse(jsonStr);
    if (
      parsed &&
      typeof parsed.engagement === "string" &&
      Array.isArray(parsed.focus) &&
      typeof parsed.tone === "string" &&
      typeof parsed.pacing === "string" &&
      typeof parsed.offScript === "boolean"
    ) {
      playerRead = parsed as PlayerRead;
    }
  } catch {
    // Malformed JSON — graceful fallback
  }

  return {
    text: precisText || result.text,
    usage: result.usage,
    playerRead,
  };
}
