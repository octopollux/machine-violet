import type Anthropic from "@anthropic-ai/sdk";
import type { SubagentStreamCallback } from "../subagent.js";
import { spawnSubagent } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { DMSessionState } from "../dm-prompt.js";
import type { FileIO } from "../scene-manager.js";
import type { GameState } from "../game-state.js";
import type { TuiCommand } from "../agent-loop.js";
import { registry } from "../tool-registry.js";
import { getModel } from "../../config/models.js";
import { TOKEN_LIMITS } from "../../config/tokens.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import type { CampaignConfig } from "../../types/config.js";
import type { CampaignRepo } from "../../tools/git/index.js";
import { queryCommitLog, performRollback } from "../../tools/git/index.js";
import type { MapData } from "../../types/maps.js";
import type { ClocksState } from "../../types/clocks.js";
import { findReferences } from "../../tools/campaign-ops/index.js";
import { validateCampaign } from "../../tools/validation/index.js";
import { norm } from "../../utils/paths.js";
import { runScribe } from "./scribe.js";
import type { ModeSession } from "../../tui/game-context.js";

// --- DM tool categories available in OOC mode ---

const OOC_READONLY_TOOLS = [
  "roll_dice", "view_area", "distance", "path_between",
  "line_of_sight", "tiles_in_range", "find_nearest", "check_clocks",
];

const OOC_ENTITY_TOOLS = ["scribe"];

const OOC_TUI_TOOLS = ["style_scene", "set_display_resources", "show_character_sheet"];

const OOC_RECOVERY_TOOLS = ["rollback"];

const OOC_DM_TOOL_NAMES = [
  ...OOC_READONLY_TOOLS,
  ...OOC_ENTITY_TOOLS,
  ...OOC_TUI_TOOLS,
  ...OOC_RECOVERY_TOOLS,
];

const OOC_DM_TOOL_SET = new Set(OOC_DM_TOOL_NAMES);

/**
 * Context snapshot for OOC mode — captured when entering, restored when exiting.
 */
export interface OOCSnapshot {
  /** The UI variant that was active before OOC */
  previousVariant: string;
  /** The DM was mid-narration when OOC was triggered */
  wasMidNarration: boolean;
}

/**
 * Result from an OOC session.
 */
export interface OOCResult extends SubagentResult {
  /** Terse summary of what happened in OOC (for DM context) */
  summary: string;
  /** The snapshot to restore */
  snapshot: OOCSnapshot;
}

/**
 * Options for building the OOC system prompt.
 */
export interface OOCPromptOptions {
  campaignName: string;
  config?: CampaignConfig;
  sessionState?: DMSessionState;
  characterSheet?: string;
  systemRules?: string;
}

/**
 * Build the OOC system prompt with campaign-specific context.
 *
 * When `config` + `sessionState` are provided, returns `TextBlockParam[]`
 * with cache_control on stable sections (identity, rules, campaign log).
 *
 * When only `campaignName` is provided (pre-game-start / backward compat),
 * returns a flat string.
 */
export function buildOOCPrompt(options: OOCPromptOptions): string | Anthropic.TextBlockParam[];

/** @deprecated Legacy overload — use options object form. */
export function buildOOCPrompt(
  campaignName: string,
  systemRules?: string,
  characterSheet?: string,
): string;

export function buildOOCPrompt(
  optionsOrName: OOCPromptOptions | string,
  systemRules?: string,
  characterSheet?: string,
): string | Anthropic.TextBlockParam[] {
  // Legacy call: buildOOCPrompt("name", rules?, sheet?)
  if (typeof optionsOrName === "string") {
    return buildOOCPromptLegacy(optionsOrName, systemRules, characterSheet);
  }

  const opts = optionsOrName;

  // If no session state, fall back to flat string
  if (!opts.sessionState || !opts.config) {
    return buildOOCPromptLegacy(opts.campaignName, opts.systemRules, opts.characterSheet);
  }

  // Build structured TextBlockParam[] with caching
  return buildOOCPromptCached({ ...opts, config: opts.config, sessionState: opts.sessionState });
}

/** Legacy flat-string builder (backward compat / pre-game-start). */
function buildOOCPromptLegacy(
  campaignName: string,
  systemRules?: string,
  characterSheet?: string,
): string {
  let prompt = loadPrompt("ooc-mode");

  if (campaignName) {
    prompt += `\n\nCampaign: ${campaignName}`;
  }

  if (systemRules) {
    prompt += `\n\nGame system rules:\n${systemRules}`;
  }

  if (characterSheet) {
    prompt += `\n\nActive character:\n${characterSheet}`;
  }

  return prompt;
}

/** Structured cached-prefix builder — mirrors DM prefix layout minus DM-internal sections. */
function buildOOCPromptCached(opts: Required<Pick<OOCPromptOptions, "config" | "sessionState">> & OOCPromptOptions): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];
  const config = opts.config;
  const ss = opts.sessionState;

  // OOC identity prompt (stable — cached)
  blocks.push({
    type: "text",
    text: loadPrompt("ooc-mode"),
    cache_control: { type: "ephemeral", ttl: "1h" },
  } as Anthropic.TextBlockParam);

  // Campaign setting
  {
    const settingLines: string[] = [`Campaign: ${opts.campaignName}`];
    if (config.system) settingLines.push(`Game System: ${config.system}`);
    if (config.genre) settingLines.push(`Genre: ${config.genre}`);
    if (config.mood) settingLines.push(`Mood: ${config.mood}`);
    if (config.difficulty) settingLines.push(`Difficulty: ${config.difficulty}`);
    if (config.premise) settingLines.push(`Premise: ${config.premise}`);
    blocks.push({
      type: "text",
      text: `\n\n## Campaign Setting\n${settingLines.join("\n")}`,
    });
  }

  // Rules appendix (stable — cached)
  if (ss.rulesAppendix || opts.systemRules) {
    blocks.push({
      type: "text",
      text: `\n\n## Rules Reference\n${ss.rulesAppendix ?? opts.systemRules}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    } as Anthropic.TextBlockParam);
  }

  // Campaign log (stable within a scene — cached)
  if (ss.campaignSummary) {
    blocks.push({
      type: "text",
      text: `\n\n## Campaign Log\n${ss.campaignSummary}`,
      cache_control: { type: "ephemeral", ttl: "1h" },
    } as Anthropic.TextBlockParam);
  }

  // Session recap (changes once at session start)
  if (ss.sessionRecap) {
    blocks.push({
      type: "text",
      text: `\n\n## Last Session\n${ss.sessionRecap}`,
    });
  }

  // Active state (location, PCs, alarms — changes during play)
  if (ss.activeState) {
    blocks.push({
      type: "text",
      text: `\n\n## Current State\n${ss.activeState}`,
    });
  }

  // Scene precis (changes as exchanges are pruned)
  if (ss.scenePrecis) {
    blocks.push({
      type: "text",
      text: `\n\n## Scene So Far\n${ss.scenePrecis}`,
    });
  }

  // Active character sheet (player-specific, uncached)
  if (opts.characterSheet) {
    blocks.push({
      type: "text",
      text: `\n\n## Active Character\n${opts.characterSheet}`,
    });
  }

  return blocks;
}

/** Build OOC tool definitions (available when repo or fileIO is provided). */
export function buildOOCTools(hasFileIO: boolean, hasGameState: boolean): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: "get_commit_log",
      description: "List git snapshot commits for this campaign. Shows commit hash, type, message, and timestamp. Use to review game history for rollback or debugging.",
      input_schema: {
        type: "object" as const,
        properties: {
          depth: { type: "number", description: "Number of commits to retrieve (default 20, max 100)" },
          type: { type: "string", enum: ["auto", "scene", "session", "checkpoint", "character"], description: "Filter by commit type" },
          search: { type: "string", description: "Filter by message content (case-insensitive)" },
        },
        required: [],
      },
    },
  ];

  if (hasFileIO) {
    tools.push(
      {
        name: "read_file",
        description: "Read a campaign file by relative path (e.g. 'characters/kael.md').",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string", description: "Relative path within the campaign directory" },
          },
          required: ["path"],
        },
      },
      {
        name: "find_references",
        description: "Find all wikilinks pointing to an entity. Returns file, display text, and line number for each reference.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string", description: "Entity path relative to campaign root (e.g. 'characters/kael.md')" },
          },
          required: ["path"],
        },
      },
      {
        name: "validate_campaign",
        description: "Run the full campaign validation suite: broken links, malformed entities, clock/map issues.",
        input_schema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
    );
  }

  // Append DM tool definitions when game state is available
  if (hasGameState) {
    tools.push(...registry.getDefinitionsFor(OOC_DM_TOOL_NAMES));
  }

  return tools;
}

/** Build OOC tool handler. */
export function buildOOCToolHandler(
  client: Anthropic | undefined,
  repo?: CampaignRepo,
  campaignRoot?: string,
  fileIO?: FileIO,
  maps?: Record<string, MapData>,
  clocks?: ClocksState,
  gameState?: GameState,
  onTuiCommand?: (cmd: TuiCommand) => void,
): (name: string, input: Record<string, unknown>) => Promise<{ content: string; is_error?: boolean }> {
  return async (name: string, input: Record<string, unknown>) => {
    try {
      switch (name) {
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

        case "read_file": {
          if (!fileIO || !campaignRoot) {
            return { content: "File I/O not available", is_error: true };
          }
          const relPath = (input.path as string).replace(/\\/g, "/").replace(/^\/+/, "");
          if (relPath.split("/").some((p) => p === "..")) {
            return { content: "Path traversal not allowed", is_error: true };
          }
          const abs = norm(campaignRoot) + "/" + relPath;
          const content = await fileIO.readFile(abs);
          return { content };
        }

        case "find_references": {
          if (!fileIO || !campaignRoot) {
            return { content: "File I/O not available", is_error: true };
          }
          const refResult = await findReferences(campaignRoot, fileIO, input.path as string);
          return { content: JSON.stringify(refResult, null, 2) };
        }

        case "validate_campaign": {
          if (!fileIO || !campaignRoot) {
            return { content: "File I/O not available", is_error: true };
          }
          const validationResult = await validateCampaign(
            campaignRoot, maps ?? {}, clocks ?? { calendar: { current: 0, epoch: "", display_format: "", alarms: [] }, combat: { current: 0, active: false, alarms: [] } },
            fileIO,
          );
          return { content: JSON.stringify(validationResult, null, 2) };
        }

        default:
          // DM tool dispatch
          if (OOC_DM_TOOL_SET.has(name) && gameState) {
            return await dispatchDMTool(name, input, gameState, client, repo, fileIO, campaignRoot, onTuiCommand);
          }
          return { content: `Unknown tool: ${name}`, is_error: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: msg, is_error: true };
    }
  };
}

/** Dispatch a DM tool from OOC context, post-processing based on category. */
async function dispatchDMTool(
  name: string,
  input: Record<string, unknown>,
  gameState: GameState,
  client?: Anthropic,
  repo?: CampaignRepo,
  fileIO?: FileIO,
  campaignRoot?: string,
  onTuiCommand?: (cmd: TuiCommand) => void,
): Promise<{ content: string; is_error?: boolean }> {
  // Read-only tools — dispatch directly and return result
  if (OOC_READONLY_TOOLS.includes(name)) {
    const result = registry.dispatch(gameState, name, input);
    return result;
  }

  // TUI tools — dispatch to get the command JSON, then forward via callback
  if (OOC_TUI_TOOLS.includes(name)) {
    const result = registry.dispatch(gameState, name, input);
    if (result.is_error) return result;
    if (onTuiCommand) {
      const cmd = JSON.parse(result.content) as TuiCommand;
      onTuiCommand(cmd);
    }
    return { content: `Applied: ${name}` };
  }

  // Scribe — spawn subagent to handle entity operations
  if (name === "scribe") {
    if (!client || !fileIO || !campaignRoot) {
      return { content: "Client and file I/O required for scribe", is_error: true };
    }
    const result = registry.dispatch(gameState, name, input);
    if (result.is_error) return result;
    const cmd = result._tui ?? JSON.parse(result.content);
    const scribeResult = await runScribe(client, {
      updates: (cmd as Record<string, unknown>).updates as { visibility: string; content: string }[],
      campaignRoot,
      sceneNumber: 0, // OOC has no scene number
    }, fileIO);
    return { content: scribeResult.summary };
  }

  // Rollback — execute via repo (prunes ghost dirs + exits)
  if (OOC_RECOVERY_TOOLS.includes(name)) {
    return await executeRollback(input, repo, campaignRoot, fileIO);
  }

  return { content: `Unknown OOC tool: ${name}`, is_error: true };
}

/** Execute rollback via performRollback — prunes ghost dirs then exits. */
async function executeRollback(
  input: Record<string, unknown>,
  repo?: CampaignRepo,
  campaignRoot?: string,
  fileIO?: FileIO,
): Promise<{ content: string; is_error?: boolean }> {
  if (!repo) {
    return { content: "Git is not available for rollback", is_error: true };
  }
  if (!campaignRoot || !fileIO) {
    return { content: "File I/O not available for rollback cleanup", is_error: true };
  }
  const target = input.target as string;
  const result = await performRollback(repo, target, campaignRoot, fileIO);
  console.log(`\nRolled back to: ${result.summary}\nRelaunch the game to resume from this point.\n`);
  process.exit(0);
}

/**
 * Enter OOC mode — spawn a Sonnet subagent that handles OOC conversation.
 * The subagent is player-facing (streams to TUI).
 *
 * Returns a terse summary for the DM when OOC ends.
 */
export async function enterOOC(
  client: Anthropic,
  playerMessage: string,
  options: {
    campaignName: string;
    config?: CampaignConfig;
    sessionState?: DMSessionState;
    systemRules?: string;
    characterSheet?: string;
    previousVariant: string;
    wasMidNarration?: boolean;
    repo?: CampaignRepo;
    fileIO?: FileIO;
    campaignRoot?: string;
    maps?: Record<string, MapData>;
    clocks?: ClocksState;
    gameState?: GameState;
    onTuiCommand?: (cmd: TuiCommand) => void;
  },
  onStream?: SubagentStreamCallback,
): Promise<OOCResult> {
  const systemPrompt = buildOOCPrompt({
    campaignName: options.campaignName,
    config: options.config,
    sessionState: options.sessionState,
    characterSheet: options.characterSheet,
    systemRules: options.systemRules,
  });

  const snapshot: OOCSnapshot = {
    previousVariant: options.previousVariant,
    wasMidNarration: options.wasMidNarration ?? false,
  };

  const hasFileIO = !!(options.fileIO && options.campaignRoot);
  const hasGameState = !!options.gameState;
  const hasTools = !!options.repo || hasFileIO || hasGameState;
  const tools = hasTools ? buildOOCTools(hasFileIO, hasGameState) : undefined;
  const toolHandler = hasTools
    ? buildOOCToolHandler(client, options.repo, options.campaignRoot, options.fileIO, options.maps, options.clocks, options.gameState, options.onTuiCommand)
    : undefined;

  const result = await spawnSubagent(
    client,
    {
      name: "ooc",
      model: getModel("medium"),
      visibility: "player_facing",
      systemPrompt,
      maxTokens: hasTools ? TOKEN_LIMITS.SUBAGENT_LARGE : TOKEN_LIMITS.SUBAGENT_MEDIUM,
      ...(tools ? { tools } : {}),
      ...(toolHandler ? { toolHandler } : {}),
      maxToolRounds: hasTools ? 8 : undefined,
    },
    playerMessage,
    onStream,
  );

  // The subagent's response IS the OOC content.
  // We also need a terse summary for the DM.
  // For a single-exchange OOC, the response itself is sufficient.
  // For multi-exchange, we'd need a follow-up summarization.
  // For now, truncate to first sentence as the summary.
  const summary = extractSummary(result.text);

  return {
    ...result,
    summary,
    snapshot,
  };
}

/**
 * Extract a terse summary from OOC text — first sentence, max 100 chars.
 */
function extractSummary(text: string): string {
  const firstSentence = text.split(/[.!?]\s/)[0];
  if (!firstSentence) return "OOC discussion.";
  const trimmed = firstSentence.trim();
  if (trimmed.length > 100) return trimmed.slice(0, 97) + "...";
  return trimmed + ".";
}

/**
 * Create a ModeSession for OOC mode.
 * Used by PlayingPhase to unify non-DM mode handling.
 */
export function createOOCSession(
  client: Anthropic,
  options: {
    campaignName: string;
    previousVariant: string;
    config?: CampaignConfig;
    sessionState?: DMSessionState;
    characterSheet?: string;
    repo?: CampaignRepo;
    fileIO?: FileIO;
    campaignRoot?: string;
    maps?: Record<string, MapData>;
    clocks?: ClocksState;
    gameState?: GameState;
    onTuiCommand?: (cmd: TuiCommand) => void;
  },
): ModeSession {
  return {
    label: "OOC",
    tier: "medium",
    send: (text, onDelta) => enterOOC(client, text, options, onDelta),
  };
}
