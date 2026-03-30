import type { LLMProvider } from "../../providers/types.js";
import { oneShot } from "../subagent.js";
import { getModel } from "../../config/models.js";
import { loadPrompt } from "../../prompts/load-prompt.js";

const SYSTEM_PROMPT = loadPrompt("discord-status");
const FALLBACK = "Adventuring...";
const MAX_LENGTH = 40;

/**
 * Generate a punchy ≤40-char status string for Discord Rich Presence.
 * Never throws — degrades to a generic fallback.
 */
export async function generateDiscordStatus(
  provider: LLMProvider,
  recentContext: string,
): Promise<string> {
  try {
    const result = await oneShot(
      provider,
      getModel("small"),
      SYSTEM_PROMPT,
      recentContext,
      60,
      "discord_status",
    );
    const status = result.text.trim().replace(/^["']|["']$/g, "").slice(0, MAX_LENGTH);
    return status || FALLBACK;
  } catch {
    return FALLBACK;
  }
}
