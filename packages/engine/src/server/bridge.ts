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
import type {
  EngineCallbacks, EngineState, TurnInfo,
  UsageStats, ModelTier, ToolResult, TuiCommand,
  ServerEvent,
} from "@machine-violet/shared";

/** Buffering config for narrative text. */
const FLUSH_INTERVAL_MS = 50;

export function createBridge(
  broadcast: (event: ServerEvent) => void,
): EngineCallbacks {
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
      // Route TUI commands to appropriate event types
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

    onUsageUpdate(_delta: UsageStats, _tier: ModelTier): void {
      // Cost data is included in state:snapshot, not sent as individual events
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
  };
}

/**
 * Route a TUI command to the appropriate WebSocket event type.
 *
 * TUI commands are the engine's way of sending structured UI updates.
 * Some map to modal:show events, others to session:mode changes, etc.
 */
function routeTuiCommand(
  command: TuiCommand,
  broadcast: (event: ServerEvent) => void,
): void {
  switch (command.type) {
    // --- DM-driven choices (rendered in Player Pane by the client) ---
    case "present_choices":
      broadcast({
        type: "modal:show",
        data: {
          type: "choice",
          id: String(command.id ?? crypto.randomUUID()),
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
      // Forward the full TUI command payload — the client knows how to render each
      broadcast({
        type: "activity:update",
        data: { engineState: `tui:${command.type}`, ...command },
      });
      break;

    // --- Commands we can safely ignore ---
    case "present_roll":
    case "show_character_sheet":
    case "dm_notes":
      // These are either dead code or client-driven — don't forward
      break;

    default:
      broadcast({
        type: "activity:update",
        data: { engineState: `tui:${command.type}` },
      });
      break;
  }
}
