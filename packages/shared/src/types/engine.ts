/**
 * Types that cross the engine/client boundary.
 *
 * These are extracted from game-engine.ts, agent-loop.ts, tool-registry.ts,
 * game-state.ts, cost-tracker.ts, and models.ts so both the engine server
 * and frontend clients can share them without importing engine internals.
 */

import type { MapData } from "./maps.js";
import type { ClocksState } from "./clocks.js";
import type { CombatState, CombatConfig } from "./combat.js";
import type { DecksState } from "./cards.js";
import type { ObjectivesState } from "./objectives.js";
import type { CampaignConfig } from "./config.js";

// --- From agent-loop.ts ---

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Reasoning/thinking tokens (counted separately from output). */
  reasoningTokens?: number;
}

/** TUI command emitted by TUI tools (update_modeline, set_ui_style, etc.) */
export interface TuiCommand {
  type: string;
  [key: string]: unknown;
}

// --- From tool-registry.ts ---

export interface ToolResult {
  content: string;
  is_error?: boolean;
  /** TUI command payload, kept out of conversation. When set, agent-session
   *  uses this for the TUI command instead of parsing `content`. */
  _tui?: Record<string, unknown>;
}

// --- From config/models.ts ---

export type ModelTier = "large" | "medium" | "small";

// --- From cost-tracker.ts ---

export interface TierTokens {
  input: number;
  output: number;
  cached: number;
}

export interface TokenBreakdown {
  byTier: Record<ModelTier, TierTokens>;
  tokens: UsageStats;
  apiCalls: number;
}

// --- From game-engine.ts ---

export type EngineState =
  | "idle"
  | "waiting_input"
  | "dm_thinking"
  | "tool_running"
  | "scene_transition"
  | "session_ending";

export interface TurnInfo {
  turnNumber: number;
  role: "player" | "dm" | "ai";
  participant: string;   // character name, or "DM"
  text: string;          // player/AI input text; empty string for DM turns
}

export interface EngineCallbacks {
  /** DM text streams in as it generates */
  onNarrativeDelta: (delta: string) => void;
  /** DM finished responding — full text available. playerAction is the tagged input that triggered this response. */
  onNarrativeComplete: (text: string, playerAction?: string) => void;
  /** Engine state changed (for activity indicators) */
  onStateChange: (state: EngineState) => void;
  /** TUI command from a tool call */
  onTuiCommand: (command: TuiCommand) => void;
  /** Tool started executing */
  onToolStart: (name: string) => void;
  /** Tool finished executing */
  onToolEnd: (name: string, result?: ToolResult) => void;
  /** Dev mode log message */
  onDevLog?: (msg: string) => void;
  /** Exchange dropped from conversation (precis will update) */
  onExchangeDropped: () => void;
  /** Usage stats updated (delta from a single API call, with its model tier) */
  onUsageUpdate: (delta: UsageStats, tier: ModelTier) => void;
  /** Content classifier refused the response — clear partial DM output */
  onRefusal?: () => void;
  /** Error occurred */
  onError: (error: Error) => void;
  /** API call is being retried after a retryable error */
  onRetry: (status: number, delayMs: number) => void;
  /** A player turn is starting (before any API work) */
  onTurnStart: (turn: TurnInfo) => void;
  /** A participant turn has ended */
  onTurnEnd: (turn: TurnInfo) => void;
}

// --- From game-state.ts ---

/**
 * All mutable game state, passed to tool handlers.
 * This is the single source of truth during a session.
 */
export interface GameState {
  maps: Record<string, MapData>;
  clocks: ClocksState;
  combat: CombatState;
  combatConfig: CombatConfig;
  decks: DecksState;
  objectives: ObjectivesState;
  config: CampaignConfig;
  campaignRoot: string;
  /** Application home directory (e.g. ~/.machine-violet) for system content paths. */
  homeDir: string;
  /** Index into config.players — tracks whose turn it is */
  activePlayerIndex: number;
  /** Per-character resource display keys */
  displayResources: Record<string, string[]>;
  /** Per-character resource values: character → key → value */
  resourceValues: Record<string, Record<string, string>>;
}

// --- From tui/game-context.ts ---

/** Interface for OOC/Dev mode sessions. */
export interface ModeSession {
  send(text: string, onDelta: (delta: string) => void): Promise<{
    usage: UsageStats;
    summary?: string;
    endSession?: boolean;
    playerAction?: string;
  }>;
  label: string;    // "OOC" | "Dev"
  tier: ModelTier;  // for cost tracking
}
