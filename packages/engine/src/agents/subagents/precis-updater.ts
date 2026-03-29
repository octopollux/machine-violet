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

/** Extended result from updatePrecis that includes optional player read and open threads. */
export interface PrecisUpdateResult extends SubagentResult {
  playerRead?: PlayerRead;
  /** Current open narrative threads for this scene, or undefined if none. */
  openThreads?: string;
  /** Active NPC intentions/plans, or undefined if none. */
  npcIntents?: string;
}

const SYSTEM_PROMPT = loadPrompt("precis-updater");

/**
 * Precis updater subagent.
 * When an exchange drops from the DM's conversation window,
 * this appends a terse summary to the running scene precis,
 * maintains the open-threads list, and extracts player sentiment signals.
 *
 * @param client - Anthropic client
 * @param currentPrecis - The current scene precis
 * @param droppedExchange - The exchange that was dropped (formatted as text)
 * @param currentOpenThreads - Current open narrative threads (empty string or undefined if none)
 * @returns Updated precis text, open threads, and optional player read
 */
export async function updatePrecis(
  client: Anthropic,
  currentPrecis: string,
  droppedExchange: string,
  currentOpenThreads?: string,
  pcIdentification?: string,
  aliasContext?: string,
  currentNpcIntents?: string,
): Promise<PrecisUpdateResult> {
  const openThreadsLine = currentOpenThreads
    ? `Current open threads: ${currentOpenThreads}`
    : "Current open threads: (none)";

  const npcIntentsLine = currentNpcIntents
    ? `\nCurrent NPC intents: ${currentNpcIntents}`
    : "";

  const pcLine = pcIdentification
    ? `\n\nPlayer characters: ${pcIdentification}`
    : "";

  const prompt = `Current precis:\n${currentPrecis}\n\n${openThreadsLine}${npcIntentsLine}${pcLine}${aliasContext ?? ""}\n\nDropped exchange:\n${droppedExchange}\n\nAppend a terse summary of the dropped exchange to the precis, then add NPC_NEXT: lines (if any NPCs have active intentions), then the OPEN: line (if any threads are open), then the PLAYER_READ: JSON line.`;

  const result = await oneShot(
    client,
    getModel("small"),
    SYSTEM_PROMPT,
    prompt,
    256,
    "precis-updater",
  );

  return parsePrecisResult(result);
}

/**
 * Parse the subagent response into precis text, open threads, and optional PlayerRead.
 * The model is expected to output:
 *   <precis text>
 *   NPC_NEXT: [[Name]] intends to [action]  ← optional, one per NPC
 *   OPEN: [[thread1]], [[thread2]]           ← optional, omitted when no threads
 *   PLAYER_READ: {"engagement":"high",...}
 *
 * If any special line is missing or malformed, that field returns undefined.
 */
export function parsePrecisResult(result: SubagentResult): PrecisUpdateResult {
  const lines = result.text.split("\n");

  const npcNextIndices = lines
    .map((l, i) => l.trim().startsWith("NPC_NEXT:") ? i : -1)
    .filter((i) => i !== -1);
  const openIdx = lines.findIndex((l) => l.trim().startsWith("OPEN:"));
  const playerReadIdx = lines.findIndex((l) => l.trim().startsWith("PLAYER_READ:"));

  // Precis text is everything before the first special line
  const firstSpecial = Math.min(
    npcNextIndices.length > 0 ? npcNextIndices[0] : Infinity,
    openIdx === -1 ? Infinity : openIdx,
    playerReadIdx === -1 ? Infinity : playerReadIdx,
  );
  const precisText = firstSpecial === Infinity
    ? result.text.trim()
    : lines.slice(0, firstSpecial).join("\n").trim();

  // Parse NPC_NEXT: lines (may be multiple)
  let npcIntents: string | undefined;
  if (npcNextIndices.length > 0) {
    const intents = npcNextIndices
      .map((i) => lines[i].replace(/^.*?NPC_NEXT:\s*/, "").trim())
      .filter(Boolean);
    npcIntents = intents.length > 0 ? intents.join("; ") : undefined;
  }

  // Parse OPEN:
  let openThreads: string | undefined;
  if (openIdx !== -1) {
    const raw = lines[openIdx].replace(/^.*?OPEN:\s*/, "").trim();
    openThreads = raw || undefined;
  }

  // Parse PLAYER_READ:
  let playerRead: PlayerRead | undefined;
  if (playerReadIdx !== -1) {
    const jsonStr = lines[playerReadIdx].replace(/^.*?PLAYER_READ:\s*/, "");
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
  }

  return {
    text: precisText || result.text,
    usage: result.usage,
    playerRead,
    openThreads,
    npcIntents,
  };
}
