import type { LLMProvider } from "../../providers/types.js";
import type { UsageStats } from "@machine-violet/shared/types/engine.js";
import { oneShot } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

const SYSTEM_PROMPT = loadPrompt("discord-status");
const FALLBACK = "Adventuring...";
const MAX_LENGTH = 40;

export interface DiscordStatusResult {
  status: string;
  /** Token usage for the small-model call, or null if the call failed and we fell back. */
  usage: UsageStats | null;
}

/**
 * Generate a punchy ≤40-char status string for Discord Rich Presence.
 * Never throws — degrades to a generic fallback (with `usage: null`).
 * Returns usage so the caller can record it against the session's CostTracker.
 */
export async function generateDiscordStatus(
  provider: LLMProvider,
  recentContext: string,
  model?: string,
): Promise<DiscordStatusResult> {
  try {
    const result = await oneShot(
      provider,
      model ?? getModel("small"),
      SYSTEM_PROMPT,
      recentContext,
      60,
      "discord_status",
    );
    const status = result.text.trim().replace(/^["']|["']$/g, "").slice(0, MAX_LENGTH);
    return { status: status || FALLBACK, usage: result.usage };
  } catch {
    return { status: FALLBACK, usage: null };
  }
}
