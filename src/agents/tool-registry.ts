import type Anthropic from "@anthropic-ai/sdk";
import type { GameState } from "./game-state.js";

// --- Types ---

type Tool = Anthropic.Tool;

/** A registered tool: Claude API schema + handler */
export interface RegisteredTool {
  definition: Tool;
  handler: (state: GameState, input: Record<string, unknown>) => ToolResult;
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

// --- Imports from T1 tools ---

import { rollDice } from "../tools/dice/index.js";
import { deck } from "../tools/cards/index.js";
import {
  createMap,
  defineRegion,
  importEntities,
  viewArea,
  distance,
  pathBetween,
  lineOfSight,
  tilesInRange,
  findNearest,
  placeEntity,
  moveEntity,
  removeEntity,
  setTerrain,
  annotate,
} from "../tools/maps/index.js";
import {
  setAlarm,
  clearAlarm,
  advanceCalendar,
  nextRound as clockNextRound,
  startCombat as clockStartCombat,
  endCombat as clockEndCombat,
  checkClocks,
} from "../tools/clocks/index.js";
import {
  startCombat,
  endCombat,
  advanceTurn,
  getCurrentTurn,
  modifyInitiative,
} from "../tools/combat/index.js";
import { campaignPaths, serializeEntity } from "../tools/filesystem/index.js";
import type { EntityFrontMatter } from "../types/entities.js";
import { slugify } from "./world-builder.js";

// --- Helpers ---

function ok(data: unknown): ToolResult {
  return { content: typeof data === "string" ? data : JSON.stringify(data) };
}

function err(message: string): ToolResult {
  return { content: message, is_error: true };
}

function requireMap(state: GameState, input: Record<string, unknown>): { map: import("../types/maps.js").MapData } | ToolResult {
  const mapId = input.map as string;
  const map = state.maps[mapId];
  if (!map) return err(`Map '${mapId}' not found.`);
  return { map };
}

// --- Tool definitions ---

const TOOL_DEFS: RegisteredTool[] = [
  // ====== DICE ======
  {
    definition: {
      name: "roll_dice",
      description: "Roll dice using standard notation. Returns individual rolls, kept dice, modifier, and total.",
      input_schema: {
        type: "object" as const,
        properties: {
          expression: { type: "string", description: "Dice notation, e.g. '2d6+3', '4d6kh3', '1d20+5; 2d8+3'" },
          reason: { type: "string", description: "Why this roll is being made" },
          display: { type: "boolean", description: "Show roll in a dramatic modal" },
          claimed_result: {
            type: "object",
            description: "Player-rolled physical dice to validate",
            properties: {
              rolls: { type: "array", items: { type: "number" } },
              total: { type: "number" },
            },
          },
        },
        required: ["expression"],
      },
    },
    handler: (_state, input) => {
      const result = rollDice(input as unknown as Parameters<typeof rollDice>[0]);
      // Terse format: "2d20kh1+5: [18,7]→23"
      const lines = result.results.map((r) => {
        const kept = r.kept ? r.kept.join(",") : r.rolls.join(",");
        return `${r.expression}: [${kept}]→${r.total}`;
      });
      return ok(lines.join("; "));
    },
  },

  // ====== CARDS/DECK ======
  {
    definition: {
      name: "deck",
      description: "Manage card decks: create, shuffle, draw, return, peek, state.",
      input_schema: {
        type: "object" as const,
        properties: {
          deck: { type: "string", description: "Deck identifier" },
          operation: { type: "string", enum: ["create", "shuffle", "draw", "return", "peek", "state"] },
          count: { type: "number", description: "Number of cards to draw/peek" },
          from: { type: "string", enum: ["top", "random", "bottom"] },
          cards: { type: "array", items: { type: "string" }, description: "Card IDs to return" },
          template: { type: "string", enum: ["standard52", "tarot", "custom"] },
          custom_cards: { type: "array", description: "Custom card definitions for 'custom' template" },
        },
        required: ["deck", "operation"],
      },
    },
    handler: (state, input) => {
      const result = deck(state.decks, input as unknown as Parameters<typeof deck>[1]);
      if (result.cards) {
        return ok(`Drew: ${result.cards.map((c) => `${c.value} of ${c.suit} [${c.raw}]`).join(", ")} (${result.remaining} remaining)`);
      }
      return ok(`Deck: ${result.remaining} cards remaining`);
    },
  },

  // ====== MAP QUERIES ======
  {
    definition: {
      name: "view_area",
      description: "View a map area as text grid with legend.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string", description: "Map ID" },
          center: { type: "string", description: "Center coordinate 'x,y'" },
          radius: { type: "number", description: "View radius in tiles" },
        },
        required: ["map", "center", "radius"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      const result = viewArea(r.map, input.center as string, input.radius as number);
      return ok(`${result.grid}\n${result.legend.join("\n")}`);
    },
  },
  {
    definition: {
      name: "distance",
      description: "Get tile distance between two coordinates.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          from: { type: "string", description: "Coordinate 'x,y'" },
          to: { type: "string", description: "Coordinate 'x,y'" },
        },
        required: ["map", "from", "to"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      const d = distance(r.map, input.from as string, input.to as string);
      return ok(`${d} tiles`);
    },
  },
  {
    definition: {
      name: "path_between",
      description: "Find shortest path between two coordinates. Returns path + distance.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          terrain_costs: { type: "object", description: "Custom terrain movement costs" },
          impassable: { type: "array", items: { type: "string" }, description: "Terrain types that block movement" },
        },
        required: ["map", "from", "to"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      const result = pathBetween(r.map, input.from as string, input.to as string, {
        terrainCosts: input.terrain_costs as Record<string, number> | undefined,
        impassable: input.impassable as string[] | undefined,
      });
      if (!result) return err("No path found.");
      return ok(`Path (${result.distance} tiles): ${result.path.join(" → ")}`);
    },
  },
  {
    definition: {
      name: "line_of_sight",
      description: "List tiles along a line between two points.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["map", "from", "to"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      const result = lineOfSight(r.map, input.from as string, input.to as string);
      const tiles = result.tiles.map((t) => {
        const ents = t.entities.length ? ` [${t.entities.map((e) => e.id).join(",")}]` : "";
        return `${t.coord}:${t.terrain}${ents}`;
      });
      return ok(tiles.join(" → "));
    },
  },
  {
    definition: {
      name: "tiles_in_range",
      description: "All tiles within range of a point, optionally filtered.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          center: { type: "string" },
          range: { type: "number" },
          filter: { type: "string", description: "'entities' or a terrain type" },
        },
        required: ["map", "center", "range"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      const results = tilesInRange(r.map, input.center as string, input.range as number, input.filter as string | undefined);
      return ok(JSON.stringify(results));
    },
  },
  {
    definition: {
      name: "find_nearest",
      description: "Find nearest entity or terrain of a given type.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          from: { type: "string" },
          type: { type: "string", description: "Entity type or terrain type to find" },
        },
        required: ["map", "from", "type"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      const result = findNearest(r.map, input.from as string, input.type as string);
      if (!result) return ok("Nothing found.");
      return ok(`'${input.type as string}' at ${result.coord} (${result.distance} tiles)`);
    },
  },

  // ====== MAP MUTATIONS ======
  {
    definition: {
      name: "place_entity",
      description: "Place an entity on a map tile.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          coord: { type: "string" },
          entity: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string" },
              notes: { type: "string" },
            },
            required: ["id", "type"],
          },
        },
        required: ["map", "coord", "entity"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      placeEntity(r.map, input.coord as string, input.entity as Parameters<typeof placeEntity>[2]);
      return ok(`Placed ${(input.entity as { id: string }).id} at ${input.coord}`);
    },
  },
  {
    definition: {
      name: "move_entity",
      description: "Move an entity to a new coordinate.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          entity_id: { type: "string" },
          to: { type: "string" },
        },
        required: ["map", "entity_id", "to"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      moveEntity(r.map, input.entity_id as string, input.to as string);
      return ok(`Moved ${input.entity_id} → ${input.to}`);
    },
  },
  {
    definition: {
      name: "remove_entity",
      description: "Remove an entity from the map.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          entity_id: { type: "string" },
        },
        required: ["map", "entity_id"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      removeEntity(r.map, input.entity_id as string);
      return ok(`Removed ${input.entity_id}`);
    },
  },
  {
    definition: {
      name: "set_terrain",
      description: "Set terrain at a coordinate or region.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          coord: { type: "string", description: "Single coordinate 'x,y'" },
          region: {
            type: "object",
            description: "Rectangular region",
            properties: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } },
          },
          terrain: { type: "string" },
        },
        required: ["map", "terrain"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      if (input.region) {
        const reg = input.region as { x1: number; y1: number; x2: number; y2: number };
        setTerrain(r.map, reg, input.terrain as string);
        return ok(`Region set to ${input.terrain}`);
      }
      setTerrain(r.map, input.coord as string, input.terrain as string);
      return ok(`${input.coord} → ${input.terrain}`);
    },
  },
  {
    definition: {
      name: "annotate",
      description: "Add a freeform annotation to a map tile.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          coord: { type: "string" },
          text: { type: "string" },
        },
        required: ["map", "coord", "text"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      annotate(r.map, input.coord as string, input.text as string);
      return ok(`Annotated ${input.coord}`);
    },
  },

  {
    definition: {
      name: "define_region",
      description: "Define a rectangular terrain region on a map.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          x1: { type: "number", description: "Left column" },
          y1: { type: "number", description: "Top row" },
          x2: { type: "number", description: "Right column" },
          y2: { type: "number", description: "Bottom row" },
          terrain: { type: "string", description: "Terrain type for the region" },
        },
        required: ["map", "x1", "y1", "x2", "y2", "terrain"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      defineRegion(r.map, input.x1 as number, input.y1 as number, input.x2 as number, input.y2 as number, input.terrain as string);
      return ok(`Region (${input.x1},${input.y1})-(${input.x2},${input.y2}) → ${input.terrain}`);
    },
  },

  // ====== MAP BULK ======
  {
    definition: {
      name: "create_map",
      description: "Create a new map.",
      input_schema: {
        type: "object" as const,
        properties: {
          id: { type: "string" },
          grid_type: { type: "string", enum: ["square", "hex"] },
          width: { type: "number" },
          height: { type: "number" },
          default_terrain: { type: "string" },
        },
        required: ["id", "grid_type", "width", "height", "default_terrain"],
      },
    },
    handler: (state, input) => {
      const map = createMap(
        input.id as string,
        input.grid_type as "square" | "hex",
        input.width as number,
        input.height as number,
        input.default_terrain as string,
      );
      state.maps[map.id] = map;
      return ok(`Map '${map.id}' created (${input.width}×${input.height} ${input.grid_type})`);
    },
  },
  {
    definition: {
      name: "import_entities",
      description: "Batch-place multiple entities on a map.",
      input_schema: {
        type: "object" as const,
        properties: {
          map: { type: "string" },
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                coord: { type: "string" },
                entity: { type: "object", properties: { id: { type: "string" }, type: { type: "string" } } },
              },
            },
          },
        },
        required: ["map", "entities"],
      },
    },
    handler: (state, input) => {
      const r = requireMap(state, input);
      if ("content" in r) return r;
      const ents = input.entities as { coord: string; entity: Parameters<typeof placeEntity>[2] }[];
      importEntities(r.map, ents);
      return ok(`Placed ${ents.length} entities`);
    },
  },

  // ====== CLOCKS ======
  {
    definition: {
      name: "set_alarm",
      description: "Set an alarm on the calendar or combat clock.",
      input_schema: {
        type: "object" as const,
        properties: {
          clock: { type: "string", enum: ["calendar", "combat"] },
          in: { type: ["number", "string"], description: "Rounds (combat) or time string like '3 days' (calendar)" },
          message: { type: "string" },
          repeating: { type: "number", description: "Repeat interval" },
        },
        required: ["clock", "in", "message"],
      },
    },
    handler: (state, input) => {
      const result = setAlarm(state.clocks, input as unknown as Parameters<typeof setAlarm>[1]);
      return ok(`Alarm ${result.id}: fires at ${result.fires_at}${result.display ? ` (${result.display})` : ""}`);
    },
  },
  {
    definition: {
      name: "clear_alarm",
      description: "Remove an alarm by ID.",
      input_schema: {
        type: "object" as const,
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
    handler: (state, input) => {
      clearAlarm(state.clocks, input.id as string);
      return ok(`Alarm ${input.id} cleared`);
    },
  },
  {
    definition: {
      name: "advance_calendar",
      description: "Advance the calendar clock by a time amount.",
      input_schema: {
        type: "object" as const,
        properties: {
          minutes: { type: "number" },
        },
        required: ["minutes"],
      },
    },
    handler: (state, input) => {
      const fired = advanceCalendar(state.clocks, input.minutes as number);
      if (fired.length === 0) return ok("Calendar advanced.");
      return ok(`Calendar advanced. Alarms fired: ${fired.map((a) => a.message).join("; ")}`);
    },
  },
  {
    definition: {
      name: "next_round",
      description: "Advance combat round counter. Fires combat alarms.",
      input_schema: { type: "object" as const, properties: {} },
    },
    handler: (state) => {
      const result = clockNextRound(state.clocks);
      const msg = `Round ${result.round}`;
      if (result.alarms_fired.length) {
        return ok(`${msg}. Alarms: ${result.alarms_fired.map((a) => a.message).join("; ")}`);
      }
      return ok(msg);
    },
  },
  {
    definition: {
      name: "check_clocks",
      description: "Read current state of all clocks and pending alarms.",
      input_schema: { type: "object" as const, properties: {} },
    },
    handler: (state) => {
      const result = checkClocks(state.clocks);
      return ok(JSON.stringify(result));
    },
  },

  // ====== COMBAT ======
  {
    definition: {
      name: "start_combat",
      description: "Roll initiative, set turn order, activate combat.",
      input_schema: {
        type: "object" as const,
        properties: {
          combatants: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                type: { type: "string", enum: ["pc", "npc", "ai_pc"] },
                modifier: { type: "number", description: "Initiative modifier" },
                initiative: { type: "number", description: "Pre-set initiative value" },
              },
              required: ["id", "type"],
            },
          },
        },
        required: ["combatants"],
      },
    },
    handler: (state, input) => {
      const combatants = input.combatants as Parameters<typeof startCombat>[1]["combatants"];
      clockStartCombat(state.clocks);
      const result = startCombat(state.combat, { combatants }, state.combatConfig);
      const order = result.order.map((e, i) => `${i + 1}. ${e.id} (${e.initiative})`).join(", ");
      return ok(`Combat started. R1. Order: ${order}`);
    },
  },
  {
    definition: {
      name: "end_combat",
      description: "End combat, clear initiative, reset combat clock.",
      input_schema: { type: "object" as const, properties: {} },
    },
    handler: (state) => {
      const result = endCombat(state.combat);
      const clockResult = clockEndCombat(state.clocks);
      return ok(`Combat ended after ${result.rounds} rounds (${clockResult.rounds} clock rounds).`);
    },
  },
  {
    definition: {
      name: "advance_turn",
      description: "Advance to the next combatant's turn.",
      input_schema: { type: "object" as const, properties: {} },
    },
    handler: (state) => {
      const result = advanceTurn(state.combat);
      const roundMsg = result.newRound ? ` (Round ${result.round})` : "";
      return ok(`${result.current.id}'s turn${roundMsg}`);
    },
  },
  {
    definition: {
      name: "modify_initiative",
      description: "Mid-combat initiative changes: add, remove, move, delay.",
      input_schema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["add", "remove", "move", "delay"] },
          combatant: { type: "string", description: "Combatant ID (or JSON for add)" },
          position: { type: "string", description: "'after:ID' or initiative value" },
        },
        required: ["action", "combatant"],
      },
    },
    handler: (state, input) => {
      modifyInitiative(state.combat, input as unknown as Parameters<typeof modifyInitiative>[1], state.combatConfig);
      const current = getCurrentTurn(state.combat);
      return ok(`Initiative modified. Current turn: ${current.id}`);
    },
  },

  // ====== TUI TOOLS ======
  {
    definition: {
      name: "update_modeline",
      description: "Set the modeline status text for a character. Defaults to the active character. Supports inline formatting: <b>, <i>, <u>, <color=#hex>.",
      input_schema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Status line content. Supports inline formatting tags: <b>, <i>, <u>, <color=#hex>." },
          character: { type: "string", description: "Character name. Defaults to active character." },
        },
        required: ["text"],
      },
    },
    handler: (state, input) => {
      const character = (input.character as string)
        || state.config.players[state.activePlayerIndex].character;
      // TUI tools return commands — the agent loop applies them
      return ok(JSON.stringify({ type: "update_modeline", text: input.text, character }));
    },
  },
  {
    definition: {
      name: "set_ui_style",
      description: "Switch frame style or variant (combat/exploration/ooc/levelup).",
      input_schema: {
        type: "object" as const,
        properties: {
          style: { type: "string", description: "Style name (gothic, arcane, etc.)" },
          variant: { type: "string", enum: ["exploration", "combat", "ooc", "levelup"] },
        },
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "set_ui_style", ...input }));
    },
  },
  {
    definition: {
      name: "set_theme",
      description: "Switch the UI theme, key color, and/or variant. Optionally persist the theme to a location entity.",
      input_schema: {
        type: "object" as const,
        properties: {
          theme: { type: "string", description: "Theme name (gothic, arcane, terminal, clean)" },
          key_color: { type: "string", description: "Hex color for swatch generation (e.g. #8844aa)" },
          variant: { type: "string", enum: ["exploration", "combat", "ooc", "levelup"] },
          save_to_location: { type: "boolean", description: "If true, persist theme + key_color to the named location entity's front matter" },
          location: { type: "string", description: "Location slug/name to save theme to (required when save_to_location is true)" },
        },
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "set_theme", ...input }));
    },
  },
  {
    definition: {
      name: "set_display_resources",
      description: "Update which resource keys appear in the top frame for a character.",
      input_schema: {
        type: "object" as const,
        properties: {
          character: { type: "string" },
          resources: { type: "array", items: { type: "string" } },
        },
        required: ["character", "resources"],
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "set_display_resources", ...input }));
    },
  },
  {
    definition: {
      name: "present_choices",
      description: "Show a choice modal to the player. No params = auto-generate options.",
      input_schema: {
        type: "object" as const,
        properties: {
          prompt: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
        },
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "present_choices", ...input }));
    },
  },
  {
    definition: {
      name: "present_roll",
      description: "Display a dice roll as a dramatic modal.",
      input_schema: {
        type: "object" as const,
        properties: {
          expression: { type: "string" },
          rolls: { type: "array", items: { type: "number" } },
          kept: { type: "array", items: { type: "number" } },
          total: { type: "number" },
          label: { type: "string" },
        },
        required: ["expression", "rolls", "total"],
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "present_roll", ...input }));
    },
  },
  {
    definition: {
      name: "show_character_sheet",
      description: "Open character sheet modal for a character.",
      input_schema: {
        type: "object" as const,
        properties: {
          character: { type: "string" },
        },
        required: ["character"],
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "show_character_sheet", ...input }));
    },
  },

  // ====== OOC ======
  {
    definition: {
      name: "enter_ooc",
      description: "Switch to OOC (out-of-character) mode. Use when the player asks a rules question, wants to discuss game meta, or says something clearly out of character.",
      input_schema: {
        type: "object" as const,
        properties: {
          reason: { type: "string", description: "Why OOC mode is being entered" },
        },
        required: ["reason"],
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "enter_ooc", reason: input.reason }));
    },
  },

  // ====== PLAYER MANAGEMENT ======
  {
    definition: {
      name: "switch_player",
      description: "Switch the active player during free play (outside combat). During combat, initiative controls turn order automatically.",
      input_schema: {
        type: "object" as const,
        properties: {
          player: { type: "string", description: "Character name of the player to activate" },
        },
        required: ["player"],
      },
    },
    handler: (state, input) => {
      const target = (input.player as string).toLowerCase();
      const idx = state.config.players.findIndex(
        (p) => p.character.toLowerCase() === target,
      );
      if (idx === -1) return err(`Player '${input.player}' not found.`);
      state.activePlayerIndex = idx;
      const p = state.config.players[idx];
      return ok(`Active player: ${p.character} (${p.type})`);
    },
  },

  // ====== SCENE/SESSION ======
  {
    definition: {
      name: "scene_transition",
      description: "Transition to a new scene. Finalizes transcript, writes campaign log, updates changelogs, advances calendar, checks alarms, resets context. Call at natural narrative boundaries.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Title for the new scene" },
          time_advance: { type: "number", description: "Minutes of in-game time to advance" },
        },
        required: ["title"],
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "scene_transition", title: input.title, time_advance: input.time_advance }));
    },
  },
  {
    definition: {
      name: "session_end",
      description: "End the current session. Runs scene transition + writes session recap.",
      input_schema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Title for the session ending" },
          time_advance: { type: "number", description: "Minutes of in-game time to advance" },
        },
        required: ["title"],
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "session_end", title: input.title, time_advance: input.time_advance }));
    },
  },

  {
    definition: {
      name: "context_refresh",
      description: "Refresh the DM's context: re-read campaign log, session recap, rebuild active state. Use when context feels stale.",
      input_schema: { type: "object" as const, properties: {} },
    },
    handler: (_state) => {
      return ok(JSON.stringify({ type: "context_refresh" }));
    },
  },

  // ====== RECOVERY ======
  {
    definition: {
      name: "rollback",
      description: "Roll back game state to a previous checkpoint. Available in OOC mode. Targets: 'last', 'scene:Title', 'session:N', 'exchanges_ago:N', or a commit hash.",
      input_schema: {
        type: "object" as const,
        properties: {
          target: { type: "string", description: "Rollback target: 'last', 'scene:Title', 'session:N', 'exchanges_ago:N', or commit hash" },
        },
        required: ["target"],
      },
    },
    handler: (_state, input) => {
      return ok(JSON.stringify({ type: "rollback", target: input.target }));
    },
  },
  {
    definition: {
      name: "validate",
      description: "Run the validation suite on the campaign. Checks entity files, wikilinks, maps, clocks, and config integrity. Returns a list of issues.",
      input_schema: { type: "object" as const, properties: {} },
    },
    handler: (_state) => {
      return ok(JSON.stringify({ type: "validate" }));
    },
  },

  // ====== WORLDBUILDING ======
  {
    definition: {
      name: "create_entity",
      description: "Create a new entity file (NPC, location, faction, or lore). Silent DM note — not narrated to players.",
      input_schema: {
        type: "object" as const,
        properties: {
          entity_type: { type: "string", enum: ["character", "location", "faction", "lore"], description: "Entity type" },
          name: { type: "string", description: "Entity name" },
          front_matter: { type: "object", description: "Front matter key-value pairs (e.g. disposition, class)" },
          body: { type: "string", description: "Markdown body content" },
        },
        required: ["entity_type", "name"],
      },
    },
    handler: (state, input) => {
      const entityType = input.entity_type as string;
      const name = input.name as string;

      if (!["character", "location", "faction", "lore"].includes(entityType)) {
        return err(`Invalid entity_type: ${entityType}`);
      }
      if (!name || !name.trim()) {
        return err("Entity name is required.");
      }

      const slug = slugify(name);
      const paths = campaignPaths(state.campaignRoot);
      const pathFn = entityType === "character" ? paths.character
        : entityType === "location" ? paths.location
        : entityType === "faction" ? paths.faction
        : paths.lore;
      const filePath = pathFn(slug);

      const fm: EntityFrontMatter = {
        type: entityType,
        ...(input.front_matter as Record<string, unknown> ?? {}),
      };
      const body = (input.body as string) ?? "";
      const content = serializeEntity(name, fm, body, []);

      return ok(JSON.stringify({
        type: "create_entity",
        entity_type: entityType,
        name,
        slug,
        file_path: filePath,
        content,
      }));
    },
  },
  {
    definition: {
      name: "update_entity",
      description: "Update an existing entity file (NPC, PC, location, faction, lore): merge front matter, append body text, add changelog. Silent DM note — use for PC sheets when the player reveals character information.",
      input_schema: {
        type: "object" as const,
        properties: {
          entity_type: { type: "string", enum: ["character", "location", "faction", "lore"], description: "Entity type" },
          name: { type: "string", description: "Entity name" },
          front_matter_updates: { type: "object", description: "Front matter keys to merge (null value deletes key)" },
          body_append: { type: "string", description: "Text to append to the body" },
          changelog_entry: { type: "string", description: "Changelog entry to add" },
        },
        required: ["entity_type", "name"],
      },
    },
    handler: (state, input) => {
      const entityType = input.entity_type as string;
      const name = input.name as string;

      if (!["character", "location", "faction", "lore"].includes(entityType)) {
        return err(`Invalid entity_type: ${entityType}`);
      }
      if (!name || !name.trim()) {
        return err("Entity name is required.");
      }

      const fmUpdates = input.front_matter_updates as Record<string, unknown> | undefined;
      const bodyAppend = input.body_append as string | undefined;
      const changelogEntry = input.changelog_entry as string | undefined;

      if (!fmUpdates && !bodyAppend && !changelogEntry) {
        return err("At least one of front_matter_updates, body_append, or changelog_entry is required.");
      }

      const slug = slugify(name);
      const paths = campaignPaths(state.campaignRoot);
      const pathFn = entityType === "character" ? paths.character
        : entityType === "location" ? paths.location
        : entityType === "faction" ? paths.faction
        : paths.lore;
      const filePath = pathFn(slug);

      return ok(JSON.stringify({
        type: "update_entity",
        entity_type: entityType,
        name,
        slug,
        file_path: filePath,
        front_matter_updates: fmUpdates,
        body_append: bodyAppend,
        changelog_entry: changelogEntry,
      }));
    },
  },
  {
    definition: {
      name: "dm_notes",
      description: "Read or write your private campaign-scope DM notes. This is your persistent scratchpad — use it for secrets, plot plans, NPC motivations, player observations, or anything you want to survive across scenes and context windows. Notes are always visible in your prefix.",
      input_schema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["read", "write"], description: "Read current notes or write new ones" },
          notes: { type: "string", description: "Your DM notes (replaces all previous notes). Required for write." },
        },
        required: ["action"],
      },
    },
    handler: (_state, input) => {
      const action = input.action as string;
      if (action === "write") {
        const notes = input.notes as string;
        if (!notes || !notes.trim()) {
          return err("Notes cannot be empty.");
        }
        return ok(JSON.stringify({ type: "dm_notes", action: "write", notes: notes.trim() }));
      }
      if (action === "read") {
        return ok(JSON.stringify({ type: "dm_notes", action: "read" }));
      }
      return err(`Invalid action: ${action}`);
    },
  },
];

// --- State change mapping ---

import type { StateSlice } from "../context/state-persistence.js";

/** Maps tool names to which state slices they mutate */
export const TOOL_STATE_MAP: Record<string, StateSlice[]> = {
  start_combat: ["combat", "clocks"],
  end_combat: ["combat", "clocks"],
  advance_turn: ["combat"],
  modify_initiative: ["combat"],
  set_alarm: ["clocks"],
  clear_alarm: ["clocks"],
  advance_calendar: ["clocks"],
  next_round: ["clocks"],
  create_map: ["maps"],
  place_entity: ["maps"],
  move_entity: ["maps"],
  remove_entity: ["maps"],
  set_terrain: ["maps"],
  annotate: ["maps"],
  import_entities: ["maps"],
  define_region: ["maps"],
  deck: ["decks"],
  switch_player: [],
};

export type OnStateChanged = (toolName: string, state: GameState, slices: StateSlice[]) => void;

// --- Registry ---

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  onStateChanged?: OnStateChanged;

  constructor() {
    for (const tool of TOOL_DEFS) {
      this.tools.set(tool.definition.name, tool);
    }
  }

  /** Get all tool definitions for the Claude API */
  getDefinitions(): Tool[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  /** Get tool definitions for a specific subset of tool names (skips unknown names) */
  getDefinitionsFor(names: string[]): Tool[] {
    return names
      .map((name) => this.tools.get(name))
      .filter((t): t is RegisteredTool => !!t)
      .map((t) => t.definition);
  }

  /** Dispatch a tool_use block to the appropriate handler */
  dispatch(state: GameState, name: string, input: Record<string, unknown>): ToolResult {
    const tool = this.tools.get(name);
    if (!tool) {
      return err(`Unknown tool: ${name}`);
    }
    try {
      const result = tool.handler(state, input);
      if (!result.is_error && this.onStateChanged) {
        const slices = TOOL_STATE_MAP[name];
        if (slices && slices.length > 0) {
          this.onStateChanged(name, state, slices);
        }
      }
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`Tool error (${name}): ${msg}`);
    }
  }

  /** Check if a tool name is registered */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Number of registered tools */
  get size(): number {
    return this.tools.size;
  }
}

/** Singleton registry instance */
export const registry = new ToolRegistry();
