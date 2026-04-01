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
import { CostTracker } from "../context/cost-tracker.js";
import type { StatePersister } from "../context/state-persistence.js";
import type { StyleVariant } from "@machine-violet/shared/types/tui.js";

/** Buffering config for narrative text. */
const FLUSH_INTERVAL_MS = 50;

export interface BridgeOptions {
  broadcast: (event: ServerEvent) => void;
  /** Cost tracker for accumulating token usage. */
  costTracker?: CostTracker;
  /** Persister for saving UI state (theme, modelines) to disk. */
  persister?: StatePersister | null;
}

export function createBridge(
  broadcastOrOpts: ((event: ServerEvent) => void) | BridgeOptions,
): EngineCallbacks {
  const opts: BridgeOptions = typeof broadcastOrOpts === "function"
    ? { broadcast: broadcastOrOpts }
    : broadcastOrOpts;
  const { broadcast, costTracker, persister } = opts;
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
      routeTuiCommand(command, broadcast, persister ?? null);
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
      broadcast({
        type: "error",
        data: { message: error.message, recoverable: false },
      });
    },

    onRetry(status: number, delayMs: number): void {
      broadcast({
        type: "error",
        data: { message: `API retry (status ${status})`, recoverable: true, status, delayMs },
      });
    },

    onRefusal(): void {
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
 * TUI commands are the engine's way of sending structured UI updates.
 * Some map to choices:presented events, others to session:mode changes, etc.
 */
function routeTuiCommand(
  command: TuiCommand,
  broadcast: (event: ServerEvent) => void,
  persister: StatePersister | null,
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
      // Persist variant to disk
      if (persister && command.variant) {
        persister.persistUI({ styleName: "clean", variant: command.variant as StyleVariant });
      }
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
      // Forward the full TUI command payload — the client knows how to render each
      broadcast({
        type: "activity:update",
        data: { engineState: `tui:${command.type}`, ...command },
      });
      // Persist modeline updates to disk
      if (persister && command.type === "update_modeline") {
        // Modeline persistence happens via the engine's tool hooks;
        // no extra persistence needed here since the engine already calls persistUI
      }
      break;

    // --- Commands we can safely ignore ---
    case "show_character_sheet":
    case "dm_notes":
      // Client-driven — don't forward
      break;

    default:
      broadcast({
        type: "activity:update",
        data: { engineState: `tui:${command.type}` },
      });
      break;
  }
}
