import type { LLMProvider, NormalizedTool, SystemBlock, TierProvider, NormalizedMessage } from "../../providers/types.js";
import type { SubagentStreamCallback } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import type { DMSessionState } from "../dm-prompt.js";
import { buildDMPrefix } from "../dm-prompt.js";
import type { FileIO } from "../scene-manager.js";
import type { GameState } from "../game-state.js";
import type { TuiCommand } from "../agent-loop.js";
import { TUI_TOOLS } from "../agent-loop.js";
import type { ToolRegistry, ToolResult } from "../tool-registry.js";
import { getMaxOutput } from "../../config/model-registry.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import type { CampaignRepo } from "../../tools/git/index.js";
import { queryCommitLog } from "../../tools/git/index.js";
import { RollbackCompleteError } from "@machine-violet/shared/types/errors.js";
import type { MapData } from "@machine-violet/shared/types/maps.js";
import type { ClocksState } from "@machine-violet/shared/types/clocks.js";
import { findReferences } from "../../tools/campaign-ops/index.js";
import { validateCampaign } from "../../tools/validation/index.js";
import { resolveCampaignPath } from "../../utils/paths.js";
import { runProviderLoop } from "../../providers/agent-loop-bridge.js";
import type { ModeSession } from "@machine-violet/shared/types/engine.js";

// --- Types ---

/**
 * Async tool handler exposed by GameEngine. Returns a ToolResult for tools
 * it handles (resolve_turn, style_scene, search_campaign, search_content),
 * or null for tools the engine doesn't intercept — falls through to
 * registry.dispatch in that case.
 */
export type EngineAsyncToolHandler = (
  name: string,
  input: Record<string, unknown>,
) => Promise<ToolResult | null>;

/** Tools that exist only in OOC — file/git inspection. Layered on top of the
 *  full DM toolset; not present in the singleton registry. */
const OOC_ONLY_TOOL_NAMES = ["read_file", "find_references", "validate_campaign", "get_commit_log"] as const;
const OOC_ONLY_TOOL_SET = new Set<string>(OOC_ONLY_TOOL_NAMES);

/** Tools deliberately excluded from OOC's view of the registry.
 *  `enter_ooc` — we're already in OOC, no need to advertise re-entry. */
const OOC_EXCLUDED_FROM_REGISTRY = new Set(["enter_ooc"]);

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
  /** Agent signaled that OOC should end */
  endSession?: boolean;
  /** In-character text to forward to the DM as player input */
  playerAction?: string;
}

/**
 * Options for building the OOC system prompt.
 */
export interface OOCPromptOptions {
  campaignName: string;
  config?: CampaignConfig;
  sessionState?: DMSessionState;
  /**
   * Reason given by the DM if the OOC session was entered via the
   * `enter_ooc` tool call (DM-initiated). Surfaces in the suffix so the
   * OOC agent knows what the DM intended to discuss.
   */
  enterReason?: string;
  /** True when the DM was mid-narration — same heuristic for suffix wording. */
  wasMidNarration?: boolean;
  /** Model ID — passed through to loadPrompt for any model-specific tweaks. */
  model?: string;
  /** Legacy: a system rules appendix when no `sessionState` is available. */
  systemRules?: string;
  /** Legacy: a character sheet block when no `sessionState` is available. */
  characterSheet?: string;
}

/**
 * Build the full OOC system prompt.
 *
 * When `config` + `sessionState` are provided (the in-game path), reuses
 * `buildDMPrefix` to produce a cache-coherent DM prefix and appends an
 * OOC suffix block at the tail. Cache breakpoints on the DM prefix are
 * preserved, so OOC enters/exits ride the same BP1/BP2 cache as normal play.
 *
 * Pre-session-state path (legacy / tests without a full SessionState)
 * falls back to the standalone OOC suffix as a flat string.
 */
export function buildOOCPrompt(options: OOCPromptOptions): string | SystemBlock[] {
  const opts = options;

  // No game state — fall back to a flat string of just the OOC suffix.
  // The DM prefix is what makes OOC feel continuous with narration; without
  // it (e.g. pre-game-start callers) we keep the suffix as-is.
  if (!opts.sessionState || !opts.config) {
    let prompt = loadPrompt("ooc-mode", opts.model);
    if (opts.campaignName) prompt += `\n\nCampaign: ${opts.campaignName}`;
    if (opts.systemRules) prompt += `\n\nGame system rules:\n${opts.systemRules}`;
    if (opts.characterSheet) prompt += `\n\nActive character:\n${opts.characterSheet}`;
    return prompt;
  }

  const prefix = buildDMPrefix(opts.config, opts.sessionState);

  // OOC suffix — appended after all DM Tier 1+2 blocks. Uncached on purpose
  // (it varies per entry and is small), and sits past the last cache_control
  // marker so BP1/BP2 keep their hits.
  const suffixParts: string[] = [`\n\n`, loadPrompt("ooc-mode", opts.model)];

  if (opts.enterReason || opts.wasMidNarration) {
    suffixParts.push(`\n\n### OOC Entry Context\n`);
    if (opts.wasMidNarration) {
      suffixParts.push(`The DM (you) called \`enter_ooc\` mid-narration. `);
    }
    if (opts.enterReason) {
      suffixParts.push(`Reason given: ${opts.enterReason}`);
    }
  }

  return [...prefix.system, { text: suffixParts.join("") }];
}

/**
 * Build the OOC tool list: every DM tool (so OOC is self-documenting from
 * the same code path as the DM) minus `enter_ooc`, plus a small set of
 * OOC-only extras for file/git inspection.
 */
export function buildOOCTools(registry: ToolRegistry, hasFileIO: boolean, hasRepo: boolean): NormalizedTool[] {
  const tools: NormalizedTool[] = registry.getDefinitions(OOC_EXCLUDED_FROM_REGISTRY);

  if (hasFileIO) {
    tools.push(
      {
        name: "read_file",
        description: "Read a campaign file by relative path (e.g. 'characters/kael.md').",
        inputSchema: {
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
        inputSchema: {
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
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
    );
  }

  if (hasRepo) {
    tools.push({
      name: "get_commit_log",
      description: "List git snapshot commits for this campaign. Shows commit hash, type, message, and timestamp. Use to review game history for rollback or debugging.",
      inputSchema: {
        type: "object" as const,
        properties: {
          depth: { type: "number", description: "Number of commits to retrieve (default 20, max 100)" },
          type: { type: "string", enum: ["auto", "scene", "session", "checkpoint", "character"], description: "Filter by commit type" },
          search: { type: "string", description: "Filter by message content (case-insensitive)" },
        },
        required: [],
      },
    });
  }

  return tools;
}

/**
 * Build the OOC tool handler.
 *
 * Dispatch order on every tool call:
 *   1. OOC-only extras (file/git inspection) — handled here directly.
 *   2. Engine async handler — resolve_turn, search_campaign, search_content,
 *      style_scene live on GameEngine. Falls through with `null` if not its tool.
 *   3. Registry dispatch — every other DM tool routes through the same
 *      singleton the DM uses, so state mutations + persistence + the
 *      onToolSuccess callbacks fire identically.
 */
export function buildOOCToolHandler(
  registry: ToolRegistry,
  gameState: GameState,
  engineAsync: EngineAsyncToolHandler | undefined,
  repo?: CampaignRepo,
  campaignRoot?: string,
  fileIO?: FileIO,
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  return async (name: string, input: Record<string, unknown>) => {
    try {
      // 1. OOC-only extras — validate_campaign reads live maps/clocks
      // straight from gameState so reports reflect current session state,
      // not stubs.
      if (OOC_ONLY_TOOL_SET.has(name)) {
        return await dispatchOOCExtra(name, input, repo, campaignRoot, fileIO, gameState.maps, gameState.clocks);
      }

      // 2. Engine async handler (DM-side async tools)
      if (engineAsync) {
        const r = await engineAsync(name, input);
        if (r !== null) return r;
      }

      // 3. Registry dispatch — full DM toolset, same semantics as DM use.
      return registry.dispatch(gameState, name, input);
    } catch (err) {
      if (err instanceof RollbackCompleteError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { content: msg, is_error: true };
    }
  };
}

/** Handle the OOC-only tool set (file/git inspection). */
async function dispatchOOCExtra(
  name: string,
  input: Record<string, unknown>,
  repo: CampaignRepo | undefined,
  campaignRoot: string | undefined,
  fileIO: FileIO | undefined,
  maps: Record<string, MapData> | undefined,
  clocks: ClocksState | undefined,
): Promise<ToolResult> {
  switch (name) {
    case "read_file": {
      if (!fileIO || !campaignRoot) {
        return { content: "File I/O not available", is_error: true };
      }
      let abs: string;
      try {
        abs = resolveCampaignPath(campaignRoot, input.path as string);
      } catch {
        return { content: "Path traversal not allowed", is_error: true };
      }
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
        campaignRoot,
        maps ?? {},
        clocks ?? { calendar: { current: 0, epoch: "", display_format: "", alarms: [] }, combat: { current: 0, active: false, alarms: [] } },
        fileIO,
      );
      return { content: JSON.stringify(validationResult, null, 2) };
    }

    case "get_commit_log": {
      if (!repo) return { content: "Git is not available", is_error: true };
      const result = await queryCommitLog(repo, {
        depth: input.depth as number | undefined,
        type: input.type as string | undefined,
        search: input.search as string | undefined,
      });
      return { content: result };
    }

    default:
      return { content: `Unknown OOC tool: ${name}`, is_error: true };
  }
}

/**
 * Enter OOC mode — run one OOC exchange through the provider.
 *
 * Reuses the DM's runProviderLoop directly so TUI command extraction, the
 * deferred-command list, and async tool handling behave identically to a
 * DM turn. Streams to the player via `onStream`.
 */
export async function enterOOC(
  provider: LLMProvider,
  playerMessage: string,
  options: {
    campaignName: string;
    config?: CampaignConfig;
    sessionState?: DMSessionState;
    systemRules?: string;
    characterSheet?: string;
    previousVariant: string;
    wasMidNarration?: boolean;
    enterReason?: string;
    repo?: CampaignRepo;
    fileIO?: FileIO;
    campaignRoot?: string;
    gameState?: GameState;
    registry?: ToolRegistry;
    /**
     * Volatile context (Tier 3) injected as a user-message preamble.
     * Mirrors the DM turn shape so OOC sees "current state", entity index,
     * UI state without those blocks invalidating the BP3 tools cache.
     */
    volatileContext?: string;
    /**
     * Async tool handler from GameEngine — surfaces resolve_turn,
     * search_campaign, search_content, style_scene to OOC the same way
     * the DM uses them.
     */
    engineAsyncTool?: EngineAsyncToolHandler;
    /** Immediate TUI command callback (modeline, resources, theme, etc.). */
    onTuiCommand?: (cmd: TuiCommand) => void;
    /** Deferred TUI command consumer — typically `engine.applyDeferredTuiCommands`. */
    onDeferredTuiCommands?: (cmds: TuiCommand[]) => Promise<void>;
    model: string;
    /** Heterogeneous-routing-safe small tier (unused now that scribe/promote
     *  go through engine.applyDeferredTuiCommands, but kept on the surface for
     *  callers that build via createOOCSession; remove once migrations land). */
    smallTier?: TierProvider;
  },
  onStream?: SubagentStreamCallback,
): Promise<OOCResult> {
  const systemPrompt = buildOOCPrompt({
    campaignName: options.campaignName,
    config: options.config,
    sessionState: options.sessionState,
    characterSheet: options.characterSheet,
    systemRules: options.systemRules,
    wasMidNarration: options.wasMidNarration,
    enterReason: options.enterReason,
    model: options.model,
  });

  const snapshot: OOCSnapshot = {
    previousVariant: options.previousVariant,
    wasMidNarration: options.wasMidNarration ?? false,
  };

  const hasFileIO = !!(options.fileIO && options.campaignRoot);
  const hasRepo = !!options.repo;
  const hasGameState = !!options.gameState && !!options.registry;
  const hasTools = hasFileIO || hasRepo || hasGameState;

  // Build tools: full DM registry minus enter_ooc, plus OOC-only extras.
  // If we don't have game state, only the OOC-only extras are available.
  const toolRegistry: ToolRegistry = hasGameState && options.registry
    ? options.registry
    : ({ getDefinitions: () => [] } as unknown as ToolRegistry);
  const tools: NormalizedTool[] = buildOOCTools(toolRegistry, hasFileIO, hasRepo);

  // Build handler chain.
  const toolHandler = hasTools && hasGameState && options.registry && options.gameState
    ? buildOOCToolHandler(
        options.registry,
        options.gameState,
        options.engineAsyncTool,
        options.repo,
        options.campaignRoot,
        options.fileIO,
      )
    : hasTools
      ? // No game state: OOC-only extras only. validate_campaign runs
        // against empty stubs in this branch — the no-gameState path is
        // for pre-session / test callers without live maps or clocks.
        async (name: string, input: Record<string, unknown>) => {
          if (OOC_ONLY_TOOL_SET.has(name)) {
            return dispatchOOCExtra(name, input, options.repo, options.campaignRoot, options.fileIO, undefined, undefined);
          }
          return { content: `Unknown tool: ${name}`, is_error: true };
        }
      : undefined;

  // Wrap the player message with volatile-context preamble, mirroring the
  // DM turn shape. Ephemeral so it doesn't poison the next-turn cache.
  const userContent = options.volatileContext
    ? `<context>\n${options.volatileContext}\n</context>\n\n${playerMessage}`
    : playerMessage;
  const messages: NormalizedMessage[] = [{
    role: "user",
    content: userContent,
    ephemeral: !!options.volatileContext,
  }];

  // Run through the same provider loop the DM uses — gets TUI command
  // extraction, deferred-list collection, and streaming for free.
  const result = await runProviderLoop(provider, systemPrompt, messages, {
    name: "ooc",
    model: options.model,
    maxTokens: getMaxOutput(options.model),
    maxToolRounds: hasTools ? 10 : 1,
    stream: !!onStream,
    tools: tools.length > 0 ? tools : undefined,
    toolHandler,
    cacheHints: tools.length > 0 ? [{ target: "tools", ttl: "1h" }] : undefined,
    tuiToolNames: TUI_TOOLS,
    onTuiCommand: options.onTuiCommand,
    onTextDelta: onStream,
  });

  // Process deferred TUI commands (scribe, promote_character, dm_notes,
  // scene_transition, session_end, rollback) the same way the DM does
  // after its turn.
  if (options.onDeferredTuiCommands && result.tuiCommands.length > 0) {
    await options.onDeferredTuiCommands(result.tuiCommands);
  }

  // Parse the OOC end signal + optional SUMMARY tag.
  const summaryParse = parseSummaryTag(result.text);
  const signal = parseEndOOCSignal(summaryParse.cleanedText);
  const summary = summaryParse.summary ?? extractSummary(signal.cleanedText);

  return {
    text: signal.cleanedText,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
    },
    summary,
    snapshot,
    endSession: signal.found || undefined,
    playerAction: signal.playerAction,
  };
}

/**
 * Parse the END_OOC signal from the agent's response.
 * The signal must appear at the end of the response text.
 *
 * Formats:
 *   <END_OOC />           — session complete, no player action
 *   <END_OOC>action</END_OOC> — session complete, forward action to DM
 */
export interface EndOOCSignal {
  found: boolean;
  playerAction?: string;
  cleanedText: string;
}

export function parseEndOOCSignal(text: string): EndOOCSignal {
  // With payload: <END_OOC>...content...</END_OOC>
  const withPayload = /\s*<END_OOC>([\s\S]*?)<\/END_OOC>\s*$/;
  const payloadMatch = text.match(withPayload);
  if (payloadMatch) {
    return {
      found: true,
      playerAction: payloadMatch[1].trim(),
      cleanedText: text.replace(withPayload, "").trimEnd(),
    };
  }

  // Self-closing: <END_OOC /> or <END_OOC/>
  const selfClosing = /\s*<END_OOC\s*\/>\s*$/;
  const selfMatch = text.match(selfClosing);
  if (selfMatch) {
    return {
      found: true,
      cleanedText: text.replace(selfClosing, "").trimEnd(),
    };
  }

  return { found: false, cleanedText: text };
}

/**
 * Parse an optional `<SUMMARY>one-line digest</SUMMARY>` tag near the end
 * of the response. Strips the tag from the visible text so the player
 * never sees it; the digest is forwarded to the DM separately.
 *
 * Scans the last 600 chars only — the SUMMARY tag belongs at the end of
 * the reply, and a tight scan keeps us from grabbing a literal example
 * tag the agent might have written earlier in the message.
 */
export function parseSummaryTag(text: string): { summary?: string; cleanedText: string } {
  const SUMMARY_RE = /<SUMMARY>([\s\S]*?)<\/SUMMARY>\s*/;
  const tail = text.slice(Math.max(0, text.length - 600));
  const tailMatch = tail.match(SUMMARY_RE);
  if (!tailMatch) return { cleanedText: text };

  // Match position in the full string.
  const offset = text.length - tail.length + tail.indexOf(tailMatch[0]);
  const cleaned = text.slice(0, offset) + text.slice(offset + tailMatch[0].length);
  return { summary: tailMatch[1].trim(), cleanedText: cleaned.trimEnd() };
}

/**
 * Extract a terse summary from OOC text — fallback when the agent omits the
 * `<SUMMARY>` tag.
 * Takes the first substantive sentence (skips filler phrases < 15 chars).
 * Falls back to first 100 chars if no sentence boundary found.
 */
export function extractSummary(text: string): string {
  if (!text.trim()) return "OOC discussion.";

  // Split on sentence boundaries (period/exclaim/question followed by space or end-of-string)
  const sentences = text.split(/(?<=[.!?])(?:\s|$)/).filter((s) => s.trim());

  // Find first substantive sentence (skip filler like "No worries", "Sure thing")
  const substantive = sentences.find((s) => s.trim().length >= 15);
  const best = substantive ?? sentences[0];

  if (!best) return "OOC discussion.";

  let trimmed = best.trim();
  // Ensure it ends with punctuation
  if (!/[.!?]$/.test(trimmed)) trimmed += ".";
  if (trimmed.length > 100) return trimmed.slice(0, 97) + "...";
  return trimmed;
}

/**
 * Create a ModeSession for OOC mode.
 * Used by PlayingPhase to unify non-DM mode handling.
 */
export function createOOCSession(
  provider: LLMProvider,
  options: {
    campaignName: string;
    previousVariant: string;
    wasMidNarration?: boolean;
    enterReason?: string;
    config?: CampaignConfig;
    sessionState?: DMSessionState;
    characterSheet?: string;
    repo?: CampaignRepo;
    fileIO?: FileIO;
    campaignRoot?: string;
    gameState?: GameState;
    registry?: ToolRegistry;
    volatileContext?: string;
    engineAsyncTool?: EngineAsyncToolHandler;
    onTuiCommand?: (cmd: TuiCommand) => void;
    onDeferredTuiCommands?: (cmds: TuiCommand[]) => Promise<void>;
    /** Model ID for the medium tier; threaded into enterOOC's options. */
    model: string;
    /** Small-tier provider+model — kept on the surface for caller back-compat
     *  even though the engine async handler now owns small-tier dispatch. */
    smallTier?: TierProvider;
  },
): ModeSession {
  return {
    label: "OOC",
    tier: "medium",
    send: (text, onDelta) => enterOOC(provider, text, options, onDelta),
  };
}
