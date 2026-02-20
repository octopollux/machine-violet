import type Anthropic from "@anthropic-ai/sdk";
import type { SubagentStreamCallback } from "../subagent.js";
import { spawnSubagent } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { GameState } from "../game-state.js";
import type { FileIO } from "../scene-manager.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import * as path from "node:path";

/**
 * Result from a Dev Mode exchange.
 */
export interface DevModeResult extends SubagentResult {
  /** Terse summary of what happened (for DM context) */
  summary: string;
}

const DEV_SYSTEM_PROMPT = `You are the Developer Console for a tabletop RPG engine.

You help the developer inspect and manipulate the running game:
- Reveal hidden game state, entity files, scene data
- Explain engine internals (agent loop, scene manager, tool registry)
- Grant items, modify stats, spawn entities on request
- Discuss the DM prompt, subagent pipeline, context window strategy
- Show raw tool call results, cost tracking, token usage

You have tools to read/write campaign files and inspect/modify game state.
USE TOOLS to look things up — do NOT guess file contents or state values.

Be direct and technical. Use short answers. You are NOT the DM — do not narrate.
When the developer is done, summarize what was discussed in one terse sentence.`;

/**
 * Build the dev mode system prompt with campaign context.
 */
export function buildDevPrompt(
  campaignName: string,
  gameStateSummary?: string,
): string {
  let prompt = DEV_SYSTEM_PROMPT;

  if (campaignName) {
    prompt += `\n\nCampaign: ${campaignName}`;
  }

  if (gameStateSummary) {
    prompt += `\n\nCurrent game state:\n${gameStateSummary}`;
  }

  return prompt;
}

// --- Tool definitions ---

type GameStateSlice = "combat" | "clocks" | "maps" | "decks" | "config" | "all";
const VALID_SLICES: GameStateSlice[] = ["combat", "clocks", "maps", "decks", "config", "all"];

/** Build the 5 dev mode tool definitions. */
export function buildDevTools(): Anthropic.Tool[] {
  return [
    {
      name: "read_file",
      description: "Read a campaign file by relative path (from campaign root).",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Relative path within the campaign directory" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write/overwrite a campaign file by relative path.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Relative path within the campaign directory" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "list_dir",
      description: "List contents of a campaign directory by relative path. Use '' or '.' for root.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Relative path within the campaign directory" },
        },
        required: ["path"],
      },
    },
    {
      name: "get_game_state",
      description: "Get a slice of live game state as JSON. Slices: combat, clocks, maps, decks, config, all.",
      input_schema: {
        type: "object" as const,
        properties: {
          slice: { type: "string", enum: VALID_SLICES, description: "Which state slice to return" },
        },
        required: ["slice"],
      },
    },
    {
      name: "set_game_state",
      description: "Patch a game state slice with a JSON merge. Slices: combat, clocks, maps, decks, config.",
      input_schema: {
        type: "object" as const,
        properties: {
          slice: {
            type: "string",
            enum: VALID_SLICES.filter((s) => s !== "all"),
            description: "Which state slice to patch",
          },
          patch: {
            type: "object",
            description: "JSON object to merge into the slice",
          },
        },
        required: ["slice", "patch"],
      },
    },
  ];
}

/**
 * Resolve a relative path within campaignRoot, rejecting traversal.
 * Returns the absolute path or throws.
 */
export function resolveDevPath(campaignRoot: string, relative: string): string {
  // Normalize to forward slashes, strip leading slash
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  // Reject .. components
  const parts = normalized.split("/");
  if (parts.some((p) => p === "..")) {
    throw new Error("Path traversal not allowed");
  }
  return path.posix.join(campaignRoot, normalized);
}

/** Build an async tool handler for dev mode tools. */
export function buildDevToolHandler(
  gameState: GameState,
  fileIO: FileIO,
): (name: string, input: Record<string, unknown>) => Promise<{ content: string; is_error?: boolean }> {
  const root = gameState.campaignRoot;

  return async (name: string, input: Record<string, unknown>) => {
    try {
      switch (name) {
        case "read_file": {
          const abs = resolveDevPath(root, input.path as string);
          const content = await fileIO.readFile(abs);
          return { content };
        }

        case "write_file": {
          const abs = resolveDevPath(root, input.path as string);
          await fileIO.writeFile(abs, input.content as string);
          return { content: `Wrote ${input.path}` };
        }

        case "list_dir": {
          const rel = (input.path as string) || ".";
          const abs = resolveDevPath(root, rel);
          const entries = await fileIO.listDir(abs);
          return { content: entries.join("\n") || "(empty directory)" };
        }

        case "get_game_state": {
          const slice = input.slice as GameStateSlice;
          if (!VALID_SLICES.includes(slice)) {
            return { content: `Unknown slice: ${slice}. Valid: ${VALID_SLICES.join(", ")}`, is_error: true };
          }
          if (slice === "all") {
            const { campaignRoot: _cr, activePlayerIndex: _api, ...rest } = gameState;
            return { content: JSON.stringify(rest, null, 2) };
          }
          const data = gameState[slice as Exclude<GameStateSlice, "all">];
          return { content: JSON.stringify(data, null, 2) };
        }

        case "set_game_state": {
          const slice = input.slice as string;
          const patch = input.patch as Record<string, unknown>;
          if (slice === "all") {
            return { content: "Cannot patch 'all' — specify a specific slice.", is_error: true };
          }
          if (!VALID_SLICES.includes(slice as GameStateSlice) || slice === "all") {
            return { content: `Unknown slice: ${slice}`, is_error: true };
          }
          const key = slice as Exclude<GameStateSlice, "all">;
          const current = gameState[key];
          Object.assign(current, patch);
          return { content: `Patched ${slice}. New value:\n${JSON.stringify(gameState[key], null, 2)}` };
        }

        default:
          return { content: `Unknown tool: ${name}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: msg, is_error: true };
    }
  };
}

/**
 * Enter Dev Mode — spawn a Sonnet subagent for developer conversation.
 * Player-facing (streams to TUI).
 */
export async function enterDevMode(
  client: Anthropic,
  playerMessage: string,
  options: {
    campaignName: string;
    gameStateSummary?: string;
    gameState?: GameState;
    fileIO?: FileIO;
  },
  onStream?: SubagentStreamCallback,
): Promise<DevModeResult> {
  const systemPrompt = buildDevPrompt(
    options.campaignName,
    options.gameStateSummary,
  );

  const hasTools = !!(options.gameState && options.fileIO);
  const tools = hasTools ? buildDevTools() : undefined;
  const toolHandler = hasTools
    ? buildDevToolHandler(options.gameState!, options.fileIO!)
    : undefined;

  const result = await spawnSubagent(
    client,
    {
      name: "dev-mode",
      model: getModel("medium"),
      visibility: "player_facing",
      systemPrompt,
      maxTokens: hasTools ? TOKEN_LIMITS.SUBAGENT_LARGE : TOKEN_LIMITS.SUBAGENT_MEDIUM,
      ...(tools ? { tools } : {}),
      ...(toolHandler ? { toolHandler } : {}),
      maxToolRounds: hasTools ? 10 : undefined,
    },
    playerMessage,
    onStream,
  );

  const summary = extractSummary(result.text);

  return {
    ...result,
    summary,
  };
}

/**
 * Build a game state summary string from live GameState for the dev prompt.
 */
export function summarizeGameState(gs: GameState): string {
  const lines: string[] = [];

  // Campaign filesystem root
  lines.push(`Campaign root: ${gs.campaignRoot}`);
  lines.push("Key paths:");
  lines.push(`  Config: ${gs.campaignRoot}/config.json`);
  lines.push(`  Characters: ${gs.campaignRoot}/characters/`);
  lines.push(`  Party: ${gs.campaignRoot}/characters/party.md`);
  lines.push(`  Players: ${gs.campaignRoot}/players/`);
  lines.push(`  Locations: ${gs.campaignRoot}/locations/`);
  lines.push(`  Campaign log: ${gs.campaignRoot}/campaign/log.md`);
  lines.push(`  Scenes: ${gs.campaignRoot}/campaign/scenes/`);

  // Players
  const players = gs.config.players;
  lines.push(`\nPlayers (${players.length}):`);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const active = i === gs.activePlayerIndex ? " [ACTIVE]" : "";
    lines.push(`  ${p.character} (${p.type}, player: ${p.name})${active}`);
  }

  // Combat
  if (gs.combat.active) {
    lines.push(`\nCombat: ACTIVE (round ${gs.combat.round})`);
    lines.push(`  Turn order (${gs.combat.order.length} combatants):`);
    for (let i = 0; i < gs.combat.order.length; i++) {
      const e = gs.combat.order[i];
      const current = i === gs.combat.currentTurn ? " ← current" : "";
      lines.push(`    ${e.id} (${e.type}, init ${e.initiative})${current}`);
    }
  } else {
    lines.push("\nCombat: inactive");
  }

  // Clocks
  const cal = gs.clocks.calendar;
  lines.push(`\nCalendar clock: tick ${cal.current} (epoch: ${cal.epoch})`);
  if (cal.alarms.length > 0) {
    lines.push("  Alarms:");
    for (const a of cal.alarms) {
      lines.push(`    ${a.id}: fires at ${a.fires_at} — "${a.message}"`);
    }
  }

  // Maps
  const mapIds = Object.keys(gs.maps);
  lines.push(`\nMaps loaded: ${mapIds.length > 0 ? mapIds.join(", ") : "none"}`);

  // Decks
  const deckIds = Object.keys(gs.decks);
  lines.push(`Decks loaded: ${deckIds.length > 0 ? deckIds.join(", ") : "none"}`);

  return lines.join("\n");
}

/**
 * Extract a terse summary — first sentence, max 100 chars.
 */
function extractSummary(text: string): string {
  const firstSentence = text.split(/[.!?]\s/)[0];
  if (!firstSentence) return "Dev mode discussion.";
  const trimmed = firstSentence.trim();
  if (trimmed.length > 100) return trimmed.slice(0, 97) + "...";
  return trimmed + ".";
}
