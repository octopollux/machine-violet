import type { LLMProvider, NormalizedTool, SystemBlock } from "../../providers/types.js";
import type { SubagentStreamCallback } from "../subagent.js";
import { spawnSubagent, cacheSystemPrompt } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { GameState } from "../game-state.js";
import type { FileIO, SceneManager } from "../scene-manager.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import { validateCampaign } from "../../tools/validation/index.js";
import { repairState } from "./repair-state.js";
import { norm, resolveCampaignPath } from "../../utils/paths.js";
import type { CampaignRepo } from "../../tools/git/index.js";
import { queryCommitLog, performRollback } from "../../tools/git/index.js";
import { RollbackCompleteError } from "@machine-violet/shared/types/errors.js";
import { registry as singletonRegistry } from "../tool-registry.js";
import { findReferences, renameEntity, mergeEntities, resolveDeadLinks } from "../../tools/campaign-ops/index.js";
import type { ModeSession } from "@machine-violet/shared/types/engine.js";
import type { TuiCommand } from "../agent-loop.js";
import { styleTheme } from "./theme-styler.js";

/**
 * Result from a Dev Mode exchange.
 */
export interface DevModeResult extends SubagentResult {
  /** Terse summary of what happened (for DM context) */
  summary: string;
}

/**
 * Build the dev mode system prompt with campaign context.
 */
export function buildDevPrompt(
  campaignName: string,
  gameStateSummary?: string,
): SystemBlock[] {
  const blocks: SystemBlock[] = [
    ...cacheSystemPrompt(loadPrompt("dev-mode")),
  ];

  const dynamicParts: string[] = [];
  if (campaignName) {
    dynamicParts.push(`Campaign: ${campaignName}`);
  }
  if (gameStateSummary) {
    dynamicParts.push(`Current game state:\n${gameStateSummary}`);
  }
  if (dynamicParts.length > 0) {
    blocks.push({ text: `\n\n${dynamicParts.join("\n\n")}` });
  }

  return blocks;
}

// --- Tool definitions ---

type GameStateSlice = "combat" | "clocks" | "maps" | "decks" | "config" | "all";
const VALID_SLICES: GameStateSlice[] = ["combat", "clocks", "maps", "decks", "config", "all"];

/** Build dev mode tool definitions: dev-specific tools + all DM tools. */
export function buildDevTools(): NormalizedTool[] {
  const devTools: NormalizedTool[] = [
    {
      name: "read_file",
      description: "Read a campaign file by relative path (from campaign root).",
      inputSchema: {
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
      inputSchema: {
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
      inputSchema: {
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
      inputSchema: {
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
      inputSchema: {
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
    {
      name: "repair_state",
      description: "Scan transcripts for wikilinked entities and generate missing entity files. Use dry_run=true to preview without writing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          dry_run: { type: "boolean", description: "If true, report what would be generated without writing files. Default: true." },
        },
        required: [],
      },
    },
    {
      name: "get_scene_state",
      description: "Get live scene state: scene number, slug, precis, open threads, exchange count.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "validate_campaign",
      description: "Run the full campaign validation suite: broken links, malformed entities, clock/map issues.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    {
      name: "search_files",
      description: "Search campaign files by regex pattern. Returns matching lines in 'file:line: content' format.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Optional subdirectory to limit search (e.g. 'characters')" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "delete_file",
      description: "Delete a campaign file by relative path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Relative path within the campaign directory" },
        },
        required: ["path"],
      },
    },
    {
      name: "get_commit_log",
      description: "List git snapshot commits for this campaign. Shows commit hash, type, message, and timestamp. Filter by type or search term.",
      inputSchema: {
        type: "object" as const,
        properties: {
          depth: { type: "number", description: "Number of commits to retrieve (default 20, max 100)" },
          type: { type: "string", enum: ["auto", "scene", "session", "checkpoint", "character"], description: "Filter by commit type" },
          search: { type: "string", description: "Filter by message content (case-insensitive)" },
        },
        required: [],
      },
    },
    {
      name: "find_references",
      description: "Find all wikilinks pointing to an entity. Returns file, display text, and line number for each reference.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Entity path relative to campaign root (e.g. 'characters/kael.md')" },
        },
        required: ["path"],
      },
    },
    {
      name: "rename_entity",
      description: "Rename an entity file and update all wikilinks across the campaign. Always dry-run first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          old_path: { type: "string", description: "Current entity path relative to campaign root" },
          new_path: { type: "string", description: "New entity path relative to campaign root" },
          dry_run: { type: "boolean", description: "If true, report changes without writing. Default: true." },
        },
        required: ["old_path", "new_path"],
      },
    },
    {
      name: "merge_entities",
      description: "Merge two entity files into the winner, repoint all loser wikilinks. Always dry-run first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          winner_path: { type: "string", description: "Entity to keep (receives merged content)" },
          loser_path: { type: "string", description: "Entity to merge in and delete" },
          dry_run: { type: "boolean", description: "If true, report changes without writing. Default: true." },
        },
        required: ["winner_path", "loser_path"],
      },
    },
    {
      name: "resolve_dead_links",
      description: "Triage dead wikilinks: classify as intentional stubs, broken refs to repoint, or missing entities to generate. Accepts freeform context. Dry-run by default.",
      inputSchema: {
        type: "object" as const,
        properties: {
          context: { type: "string", description: "Freeform description of the problem (e.g. 'I renamed kael.md to kael-ranger.md')" },
          dry_run: { type: "boolean", description: "If true (default), report without writing. If false, apply repoints and generate stubs." },
        },
        required: ["context"],
      },
    },
  ];

  // Append all DM tools, skipping any names already defined above
  const devNames = new Set(devTools.map((t) => t.name));
  for (const def of singletonRegistry.getDefinitions()) {
    if (!devNames.has(def.name)) {
      devTools.push(def);
    }
  }

  return devTools;
}

/**
 * Resolve a relative path within campaignRoot, rejecting traversal.
 * Returns the absolute path or throws.
 */
export function resolveDevPath(campaignRoot: string, relative: string): string {
  return resolveCampaignPath(campaignRoot, relative);
}

/** Build an async tool handler for dev mode tools. */
export function buildDevToolHandler(
  gameState: GameState,
  fileIO: FileIO,
  provider?: LLMProvider,
  sceneManager?: SceneManager,
  repo?: CampaignRepo,
  onTuiCommand?: (cmd: TuiCommand) => void,
): (name: string, input: Record<string, unknown>) => Promise<{ content: string; is_error?: boolean }> {
  const root = gameState.campaignRoot;
  const dmRegistry = singletonRegistry;

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
            const { campaignRoot: _cr, activePlayerIndex: _api, ...rest } = gameState; // eslint-disable-line @typescript-eslint/no-unused-vars
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

        case "repair_state": {
          if (!provider) {
            return { content: "No API client available for repair", is_error: true };
          }
          const dryRun = input.dry_run !== false; // default true
          const repairResult = await repairState(provider, gameState, fileIO, dryRun);
          return { content: JSON.stringify(repairResult, null, 2) };
        }

        case "get_scene_state": {
          if (!sceneManager) {
            return { content: "No scene manager available", is_error: true };
          }
          const scene = sceneManager.getScene();
          return {
            content: JSON.stringify({
              sceneNumber: scene.sceneNumber,
              slug: scene.slug,
              precis: scene.precis,
              openThreads: scene.openThreads,
              exchangeCount: scene.transcript.length,
            }, null, 2),
          };
        }

        case "validate_campaign": {
          const validationResult = await validateCampaign(root, gameState.maps, gameState.clocks, fileIO);
          return { content: JSON.stringify(validationResult, null, 2) };
        }

        case "search_files": {
          const pattern = new RegExp(input.pattern as string, "gi");
          const searchPath = input.path ? resolveDevPath(root, input.path as string) : root;
          const matches = await searchCampaignFiles(searchPath, fileIO, pattern);
          return { content: matches.length > 0 ? matches.join("\n") : "(no matches)" };
        }

        case "delete_file": {
          const abs = resolveDevPath(root, input.path as string);
          if (!fileIO.deleteFile) {
            return { content: "Delete not supported", is_error: true };
          }
          await fileIO.deleteFile(abs);
          return { content: `Deleted ${input.path}` };
        }

        case "get_commit_log": {
          if (!repo) {
            return { content: "Git is not available", is_error: true };
          }
          const result = await queryCommitLog(repo, {
            depth: input.depth as number | undefined,
            type: input.type as string | undefined,
            search: input.search as string | undefined,
          });
          return { content: result };
        }

        case "find_references": {
          const refResult = await findReferences(root, fileIO, input.path as string);
          return { content: JSON.stringify(refResult, null, 2) };
        }

        case "rename_entity": {
          const dryRun = input.dry_run !== false; // default true
          const renameResult = await renameEntity(
            root, fileIO, input.old_path as string, input.new_path as string, dryRun,
          );
          return { content: JSON.stringify(renameResult, null, 2) };
        }

        case "merge_entities": {
          const dryRun = input.dry_run !== false; // default true
          const mergeResult = await mergeEntities(
            root, fileIO, input.winner_path as string, input.loser_path as string, dryRun,
          );
          return { content: JSON.stringify(mergeResult, null, 2) };
        }

        case "resolve_dead_links": {
          if (!provider) {
            return { content: "No API client available for dead link resolution", is_error: true };
          }
          const dryRun = input.dry_run !== false;
          const resolveResult = await resolveDeadLinks(root, fileIO, provider, input.context as string, dryRun);
          return { content: JSON.stringify(resolveResult, null, 2) };
        }

        case "style_scene": {
          // Handle style_scene with subagent support
          const description = input.description as string | undefined;
          if (description && provider) {
            const stylerResult = await styleTheme(provider, description);
            if (stylerResult.command && onTuiCommand) {
              onTuiCommand(stylerResult.command);
              return { content: `Styled: theme=${stylerResult.command.theme ?? "(unchanged)"} key_color=${stylerResult.command.key_color ?? "(unchanged)"}` };
            }
            if (stylerResult.command) {
              return { content: JSON.stringify(stylerResult.command, null, 2) };
            }
            return { content: "Theme styler could not interpret the request.", is_error: true };
          }
          // Direct key_color/variant — dispatch as set_theme TUI command
          const themeCmd: TuiCommand = { type: "set_theme" };
          if (input.key_color) themeCmd.key_color = input.key_color as string;
          if (input.variant) themeCmd.variant = input.variant as string;
          if (onTuiCommand && (themeCmd.key_color || themeCmd.variant)) {
            onTuiCommand(themeCmd);
            return { content: `Applied: ${themeCmd.key_color ? `key_color=${themeCmd.key_color}` : ""}${themeCmd.variant ? ` variant=${themeCmd.variant}` : ""}`.trim() };
          }
          return { content: JSON.stringify(themeCmd, null, 2) };
        }

        default: {
          // Fall through to DM tool registry
          if (!dmRegistry.has(name)) {
            return { content: `Unknown tool: ${name}`, is_error: true };
          }
          const result = dmRegistry.dispatch(gameState, name, input);

          // Intercept rollback command — execute and exit
          if (!result.is_error) {
            try {
              const parsed = JSON.parse(result.content);
              if (parsed.type === "rollback") {
                if (!repo) {
                  return { content: "Rollback unavailable: git is disabled.", is_error: true };
                }
                const rb = await performRollback(repo, parsed.target as string, root, fileIO);
                throw new RollbackCompleteError(rb.summary);
              }
              // Forward TUI commands when callback is available
              if (onTuiCommand && parsed.type) {
                onTuiCommand(parsed as TuiCommand);
                return { content: `Applied: ${name}` };
              }
            } catch { /* not JSON — pass through */ }
          }

          return { content: result.content, is_error: result.is_error };
        }
      }
    } catch (err) {
      if (err instanceof RollbackCompleteError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { content: msg, is_error: true };
    }
  };
}

/**
 * Walk campaign directories and search for pattern matches in .md and .json files.
 */
async function searchCampaignFiles(
  searchRoot: string,
  fileIO: FileIO,
  pattern: RegExp,
): Promise<string[]> {
  const matches: string[] = [];
  const maxResults = 100;

  async function walkDir(dirPath: string, prefix: string): Promise<void> {
    if (matches.length >= maxResults) return;
    let entries: string[];
    try {
      entries = await fileIO.listDir(dirPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      const fullPath = norm(dirPath) + "/" + entry;
      const relPath = prefix ? prefix + "/" + entry : entry;

      if (entry.endsWith(".md") || entry.endsWith(".json")) {
        try {
          const content = await fileIO.readFile(fullPath);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;
            // Reset lastIndex for global regex
            pattern.lastIndex = 0;
            if (pattern.test(lines[i])) {
              matches.push(`${relPath}:${i + 1}: ${lines[i]}`);
            }
          }
        } catch {
          // Skip unreadable files
        }
      } else if (!entry.includes(".")) {
        // Likely a directory — recurse
        await walkDir(fullPath, relPath);
      }
    }
  }

  await walkDir(searchRoot, "");
  return matches;
}

/**
 * Enter Dev Mode — spawn a Sonnet subagent for developer conversation.
 * Player-facing (streams to TUI).
 */
export async function enterDevMode(
  provider: LLMProvider,
  playerMessage: string,
  options: {
    campaignName: string;
    gameStateSummary?: string;
    gameState?: GameState;
    fileIO?: FileIO;
    sceneManager?: SceneManager;
    repo?: CampaignRepo;
    onTuiCommand?: (cmd: TuiCommand) => void;
    model?: string;
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
    ? buildDevToolHandler(options.gameState as NonNullable<typeof options.gameState>, options.fileIO as NonNullable<typeof options.fileIO>, provider, options.sceneManager, options.repo, options.onTuiCommand)
    : undefined;

  const result = await spawnSubagent(
    provider,
    {
      name: "dev-mode",
      model: options.model ?? getModel("medium"),
      visibility: "player_facing",
      systemPrompt,
      maxTokens: TOKEN_LIMITS.DEV_MODE,
      ...(tools ? { tools, cacheTools: true } : {}),
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
  lines.push(`  Campaign log: ${gs.campaignRoot}/campaign/log.json`);
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
  const deckIds = Object.keys(gs.decks.decks);
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

/**
 * Create a ModeSession for Dev mode.
 * Used by PlayingPhase to unify non-DM mode handling.
 */
export function createDevSession(
  provider: LLMProvider,
  options: {
    campaignName: string;
    gameStateSummary?: string;
    gameState?: GameState;
    fileIO?: FileIO;
    sceneManager?: SceneManager;
    repo?: CampaignRepo;
    onTuiCommand?: (cmd: TuiCommand) => void;
    /** Model ID for the medium tier; threaded into enterDevMode's options. */
    model?: string;
  },
): ModeSession {
  return {
    label: "Dev",
    tier: "medium",
    send: (text, onDelta) => enterDevMode(provider, text, options, onDelta),
  };
}
