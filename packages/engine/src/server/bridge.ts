/**
 * Engine → WebSocket bridge.
 *
 * Implements EngineCallbacks by broadcasting WebSocket events to all
 * connected clients. This is the translation layer between the
 * GameEngine's callback interface and the wire protocol.
 *
 * Narrative deltas are buffered to word boundaries before broadcasting,
 * reducing WebSocket message volume with no perceptible latency impact.
 */
import { randomUUID } from "node:crypto";
import type {
  EngineCallbacks, EngineState, TurnInfo,
  UsageStats, ModelTier, ToolResult, TuiCommand,
  ServerEvent,
} from "@machine-violet/shared";
import { logEvent } from "../context/engine-log.js";
import { CostTracker } from "../context/cost-tracker.js";
/** Buffering config for narrative text. */
const FLUSH_INTERVAL_MS = 50;

export interface BridgeOptions {
  broadcast: (event: ServerEvent) => void;
  /** Cost tracker for accumulating token usage. */
  costTracker?: CostTracker;
}

export function createBridge(
  broadcastOrOpts: ((event: ServerEvent) => void) | BridgeOptions,
): EngineCallbacks {
  const opts: BridgeOptions = typeof broadcastOrOpts === "function"
    ? { broadcast: broadcastOrOpts }
    : broadcastOrOpts;
  const { broadcast, costTracker } = opts;
  // --- Narrative buffering ---
  let buffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushBuffer(): void {
    if (buffer) {
      broadcast({
        type: "narrative:chunk",
        data: { text: buffer, kind: "dm" },
      });
      buffer = "";
    }
    flushTimer = null;
  }

  function bufferDelta(delta: string): void {
    buffer += delta;
    // Flush on word boundary (space, newline) or when buffer is large
    if (/[\s\n]$/.test(buffer) || buffer.length > 200) {
      if (flushTimer) clearTimeout(flushTimer);
      flushBuffer();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
    }
  }

  // --- Callbacks ---

  return {
    onNarrativeDelta(delta: string): void {
      bufferDelta(delta);
    },

    onNarrativeComplete(text: string, playerAction?: string): void {
      // Flush any remaining buffer
      if (flushTimer) clearTimeout(flushTimer);
      flushBuffer();

      broadcast({
        type: "narrative:complete",
        data: { text, playerAction },
      });
    },

    onStateChange(state: EngineState): void {
      broadcast({
        type: "activity:update",
        data: { engineState: state },
      });
    },

    onTuiCommand(command: TuiCommand): void {
      routeTuiCommand(command, broadcast);
    },

    onToolStart(name: string): void {
      broadcast({
        type: "activity:update",
        data: { toolStarted: name },
      });
    },

    onToolEnd(name: string, _result?: ToolResult): void {
      broadcast({
        type: "activity:update",
        data: { toolEnded: name },
      });
    },

    onExchangeDropped(): void {
      // No client-visible action needed — the engine handles precis updates internally
    },

    onUsageUpdate(delta: UsageStats, tier: ModelTier): void {
      if (costTracker) {
        costTracker.record(delta, tier);
      }
    },

    onError(error: Error): void {
      logEvent("engine:error", { message: error.message });
      broadcast({
        type: "error",
        data: { message: error.message, recoverable: false },
      });
    },

    onRetry(status: number, delayMs: number): void {
      logEvent("api:retry", { status, delayMs });
      broadcast({
        type: "error",
        data: { message: `API retry (status ${status})`, recoverable: true, status, delayMs },
      });
    },

    onRefusal(): void {
      logEvent("api:refusal");
      broadcast({
        type: "error",
        data: { message: "Content classifier refused the response.", recoverable: false },
      });
    },

    onTurnStart(_turn: TurnInfo): void {
      // Turn lifecycle is managed by TurnManager, not the engine callbacks
    },

    onTurnEnd(_turn: TurnInfo): void {
      // Turn lifecycle is managed by TurnManager
    },

    onDevLog(msg: string): void {
      broadcast({ type: "narrative:chunk", data: { text: msg, kind: "dev" } });
    },
  };
}

/**
 * Route a TUI command to the appropriate WebSocket event type.
 *
 * Persistence (resources, UI state) is handled by the session-manager
 * after each DM turn completes — not inline here.
 */
function routeTuiCommand(
  command: TuiCommand,
  broadcast: (event: ServerEvent) => void,
): void {
  switch (command.type) {
    // --- DM-driven choices (rendered in Player Pane by the client) ---
    case "present_choices":
      broadcast({
        type: "choices:presented",
        data: {
          id: String(command.id ?? randomUUID()),
          prompt: String(command.prompt ?? ""),
          choices: (command.choices as string[]) ?? [],
          descriptions: command.descriptions as string[] | undefined,
        },
      });
      break;

    // --- Mode changes ---
    case "style_scene":
      broadcast({
        type: "session:mode",
        data: { mode: "play", variant: command.variant as string | undefined },
      });
      break;

    case "enter_ooc":
      broadcast({
        type: "session:mode",
        data: { mode: "ooc", variant: "ooc" },
      });
      break;

    // --- State-affecting commands: forward as-is for the client to interpret ---
    case "update_modeline":
    case "set_display_resources":
    case "set_resource_values":
    case "resource_refresh":
    case "set_theme":
      broadcast({
        type: "activity:update",
        data: { engineState: `tui:${command.type}`, ...command },
      });
      break;

    // --- Client-rendered modals (forwarded for OOC/Dev Mode) ---
    case "show_character_sheet":
      broadcast({
        type: "activity:update",
        data: { engineState: `tui:${command.type}`, ...command },
      });
      break;

    // --- Commands we can safely ignore ---
    case "dm_notes":
      // Engine-internal — don't forward
      break;

    default:
      broadcast({
        type: "activity:update",
        data: { engineState: `tui:${command.type}` },
      });
      break;
  }
}
