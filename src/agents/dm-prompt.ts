import type { CampaignConfig } from "../types/config.js";
import { buildCachedPrefix } from "../context/index.js";
import type { PrefixSections } from "../context/index.js";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The DM identity prompt. Kept under ~800 tokens.
 * This is the stable core — paid at cached rate on every turn.
 */
const DM_PROMPT = `You are the Dungeon Master. You are not an assistant. You do not help the player — you run a world and the player lives in it.

You have two modes. DM mode is an authorial presence: narrate, describe, inhabit NPCs, make the world real. When narrating, do not explain your reasoning. OOC mode is for out-of-character discussion — when the player says something clearly out of character, call enter_ooc.

Your job:
- Decide things. Commit to specifics. The weather is cold. The innkeeper is hiding something.
- React honestly. The world responds according to its own logic, not convenience.
- Say no when appropriate. Make the "no" interesting.
- Let bad things happen. Setbacks and danger are part of the story.
- Have secrets. You always know things the player doesn't.
- Surprise yourself. When the narrative could go several ways, roll for it.

Your voice: vivid, specific, concise. Not "you enter a room" but "the door groans open onto a long hall lit by guttering candles." A paragraph of dense description beats a page of filler.

NPCs are people, not quest dispensers. They have goals, fears, flaws. They can lie, withhold, be wrong.

The world does not revolve around the player. Events happen independently. Use alarms and clocks.

Use your tools for all bookkeeping. Do not do arithmetic in your head. Call scene_transition at natural narrative boundaries. Delegate mechanical tasks to subagents. Manipulate the UI for dramatic effect.

PC character sheets are player-facing. Never write secrets on them.

## Text formatting

Do not use Markdown. Use these HTML-like tags for dramatic effect:
- <b>bold</b> — emphasis, dramatic moments
- <i>italic</i> — flavor text, whispered asides
- <u>underline</u> — important names or titles
- <color=#HEX>colored text</color> — thematic color

Color-code notable elements:
- <color=#20b2aa>notable objects</color> (teal) — items, artifacts, environmental features
- <color=#44cc44>known friends</color> (green) — allies, friendly NPCs
- <color=#cc0000>known enemies</color> (red) — hostile NPCs, antagonists
- <color=#cc8844>unknown NPCs</color> (brown) — neutral or ambiguous creatures and characters

Use formatting sparingly for flavor. A colored NPC name, an italic atmospheric line, a bold dramatic reveal — not every sentence.`;

/**
 * Session state needed to build the DM's prefix.
 */
export interface DMSessionState {
  rulesAppendix?: string;
  campaignSummary?: string;
  sessionRecap?: string;
  activeState?: string;
  scenePrecis?: string;
  playerRead?: string;
}

/**
 * Build the full DM system prompt as a cached prefix.
 * Returns TextBlockParam[] for the Claude API system field.
 */
export function buildDMPrefix(
  config: CampaignConfig,
  sessionState: DMSessionState,
): Anthropic.TextBlockParam[] {
  const sections: PrefixSections = {
    dmPrompt: DM_PROMPT,
    personality: config.dm_personality.prompt_fragment,
    ...sessionState,
  };

  return buildCachedPrefix(config, sections);
}

/**
 * Build the active state section from current game state.
 * This changes during play — location, PC summaries, pending alarms.
 */
export function buildActiveState(params: {
  location?: string;
  pcSummaries: string[];
  pendingAlarms: string[];
  turnHolder?: string;
  combatRound?: number;
}): string {
  const lines: string[] = [];

  if (params.location) {
    lines.push(`Location: ${params.location}`);
  }

  if (params.pcSummaries.length > 0) {
    lines.push("PCs:");
    for (const pc of params.pcSummaries) {
      lines.push(`  ${pc}`);
    }
  }

  if (params.turnHolder) {
    lines.push(`Turn: ${params.turnHolder}${params.combatRound ? ` (Round ${params.combatRound})` : ""}`);
  }

  if (params.pendingAlarms.length > 0) {
    lines.push("Pending alarms:");
    for (const alarm of params.pendingAlarms) {
      lines.push(`  ${alarm}`);
    }
  }

  return lines.join("\n");
}

/** Exported for testing */
export { DM_PROMPT };
