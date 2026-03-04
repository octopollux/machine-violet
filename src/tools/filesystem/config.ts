import type { CampaignConfig } from "../../types/config.js";
import { CAMPAIGN_FORMAT_VERSION } from "../../types/config.js";

/**
 * Validate a campaign config object.
 * Returns an array of error messages (empty = valid).
 */
export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (typeof config !== "object" || config === null) {
    return ["Config must be an object"];
  }

  const c = config as Record<string, unknown>;

  if (typeof c.name !== "string" || c.name.length === 0) {
    errors.push("name is required and must be a non-empty string");
  }

  if (!c.dm_personality || typeof c.dm_personality !== "object") {
    errors.push("dm_personality is required");
  } else {
    const dm = c.dm_personality as Record<string, unknown>;
    if (typeof dm.name !== "string") errors.push("dm_personality.name is required");
    if (typeof dm.prompt_fragment !== "string")
      errors.push("dm_personality.prompt_fragment is required");
  }

  if (!Array.isArray(c.players) || c.players.length === 0) {
    errors.push("players must be a non-empty array");
  } else {
    for (let i = 0; i < c.players.length; i++) {
      const p = c.players[i] as Record<string, unknown>;
      if (typeof p.name !== "string") errors.push(`players[${i}].name is required`);
      if (typeof p.character !== "string")
        errors.push(`players[${i}].character is required`);
      if (p.type !== "human" && p.type !== "ai")
        errors.push(`players[${i}].type must be "human" or "ai"`);
    }
  }

  if (!c.combat || typeof c.combat !== "object") {
    errors.push("combat config is required");
  } else {
    const combat = c.combat as Record<string, unknown>;
    const validMethods = ["d20_dex", "card_draw", "fiction_first", "custom"];
    if (!validMethods.includes(combat.initiative_method as string)) {
      errors.push(
        `combat.initiative_method must be one of: ${validMethods.join(", ")}`,
      );
    }
    const validStructures = ["individual", "side", "popcorn"];
    if (!validStructures.includes(combat.round_structure as string)) {
      errors.push(
        `combat.round_structure must be one of: ${validStructures.join(", ")}`,
      );
    }
  }

  if (!c.context || typeof c.context !== "object") {
    errors.push("context config is required");
  }

  if (!c.recovery || typeof c.recovery !== "object") {
    errors.push("recovery config is required");
  }

  if (!c.choices || typeof c.choices !== "object") {
    errors.push("choices config is required");
  } else {
    const ch = c.choices as Record<string, unknown>;
    const validFreqs = ["none", "rarely", "often", "always"];
    if (!validFreqs.includes(ch.campaign_default as string)) {
      errors.push(
        `choices.campaign_default must be one of: ${validFreqs.join(", ")}`,
      );
    }
  }

  return errors;
}

/**
 * Create a minimal valid campaign config.
 */
export function createDefaultCampaignConfig(
  name: string,
  playerName: string,
  characterName: string,
): CampaignConfig {
  return {
    version: CAMPAIGN_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    name,
    dm_personality: {
      name: "Classic DM",
      prompt_fragment: "You are a fair and creative Dungeon Master.",
    },
    players: [
      { name: playerName, character: characterName, type: "human" },
    ],
    combat: {
      initiative_method: "d20_dex",
      round_structure: "individual",
      surprise_rules: true,
    },
    context: {
      retention_exchanges: 50,
      max_conversation_tokens: 30000,
      tool_result_stub_after: 9999,
    },
    recovery: {
      auto_commit_interval: 3,
      max_commits: 100,
      enable_git: true,
    },
    choices: {
      campaign_default: "often",
      player_overrides: {},
    },
  };
}
