import type { LLMProvider } from "../../providers/types.js";
import { oneShot, type SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

const SYSTEM_PROMPT = loadPrompt("scene-tracker");

/** How often (in player exchanges) the scene tracker runs. */
export const SCENE_TRACKER_CADENCE = 4;

/** How many transcript lines to send (≈3 player+DM exchange pairs). */
const TRANSCRIPT_TAIL = 6;

export interface SceneTrackerResult extends SubagentResult {
  /** Comma-separated wikilinks, "" for explicitly none, undefined if model output was malformed. */
  openThreads?: string;
  npcIntents?: string;
}

/**
 * Periodic scene housekeeping subagent.
 * Currently: extracts open narrative threads and NPC intentions from recent transcript.
 * Never throws — returns undefined fields on failure (callers preserve existing state).
 */
export async function trackScene(
  provider: LLMProvider,
  recentTranscript: string[],
  currentOpenThreads?: string,
  currentNpcIntents?: string,
): Promise<SceneTrackerResult> {
  const tail = recentTranscript.slice(-TRANSCRIPT_TAIL);
  const parts: string[] = [];
  if (currentOpenThreads) parts.push(`Current threads: ${currentOpenThreads}`);
  if (currentNpcIntents) parts.push(`Current NPC intents: ${currentNpcIntents}`);
  parts.push(`\nRecent transcript:\n${tail.join("\n")}`);

  try {
    const result = await oneShot(
      provider,
      getModel("small"),
      SYSTEM_PROMPT,
      parts.join("\n"),
      128,
      "scene-tracker",
    );
    return parseSceneTrackerResult(result);
  } catch {
    // Undefined fields signal "no update" — callers preserve existing state
    return {
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  }
}

/** Exported for testing. */
export function parseSceneTrackerResult(result: SubagentResult): SceneTrackerResult {
  const lines = result.text.split("\n");

  // Parse THREADS: line — undefined means "no usable output" (don't clear existing threads)
  const threadsIdx = lines.findIndex((l) => l.trim().startsWith("THREADS:"));
  let openThreads: string | undefined;
  if (threadsIdx !== -1) {
    const raw = lines[threadsIdx].replace(/^.*?THREADS:\s*/, "").trim();
    openThreads = (raw && raw !== "(none)") ? raw : "";
  }

  // Parse NPC_NEXT: lines (may be multiple)
  const npcNextIndices = lines
    .map((l, i) => (l.trim().startsWith("NPC_NEXT:") ? i : -1))
    .filter((i) => i !== -1);
  let npcIntents: string | undefined;
  if (npcNextIndices.length > 0) {
    const intents = npcNextIndices
      .map((i) => lines[i].replace(/^.*?NPC_NEXT:\s*/, "").trim())
      .filter(Boolean);
    npcIntents = intents.length > 0 ? intents.join("; ") : undefined;
  }

  return {
    text: result.text,
    usage: result.usage,
    openThreads,
    npcIntents,
  };
}
