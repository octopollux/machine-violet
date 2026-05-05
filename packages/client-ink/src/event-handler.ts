/**
 * Maps WebSocket server events to client-side state updates.
 *
 * This is the client-side counterpart of the engine's bridge.ts.
 * The engine translates EngineCallbacks → ServerEvents, and this
 * module translates ServerEvents → React state updates.
 */
import { getToolGlyph, type ToolGlyph } from "./tui/activity.js";
import type {
  ServerEvent,
  NarrativeChunkEvent,
  NarrativeCompleteEvent,
  TurnOpenedEvent,
  TurnUpdatedEvent,
  TurnCommittedEvent,
  TurnResolvedEvent,
  ChoicesPresentedEvent,
  ChoicesClearedEvent,
  ChoicesData,
  ActivityUpdateEvent,
  StateSnapshotEvent,
  SessionModeEvent,
  SessionEndedEvent,
  ErrorEvent,
  Turn,
  StateSnapshot,
} from "@machine-violet/shared";
import type { NarrativeLine, StyleVariant } from "@machine-violet/shared/types/tui.js";
import { appendDelta } from "./tui/narrative-helpers.js";

// --- State types that the handler manages ---

export interface ClientState {
  narrativeLines: NarrativeLine[];
  currentTurn: Turn | null;
  activeChoices: ChoicesData | null;
  engineState: string | null;
  /** Wall-clock timestamp (ms) when `engineState` last changed value.
   *  Used by ActivityLine to render elapsed-time hints during long waits.
   *  null when engineState is null. */
  engineStateSince: number | null;
  /** Accumulated tool glyphs for the current DM turn. Cleared on new turn. */
  toolGlyphs: ToolGlyph[];
  variant: StyleVariant;
  mode: "play" | "ooc" | "dev" | "setup";
  stateSnapshot: StateSnapshot | null;
  sessionEnded: boolean;
  /** Set when the client detects it is out of sync with the backend
   *  (campaign changed, session ended while disconnected, etc.).
   *  The UI should show a message and return the user to the main menu. */
  sessionStale: boolean;
  /** Set when the server transitions from setup to a real campaign.
   *  The client should reconnect to pick up the new session. */
  transitionCampaignId: string | null;
  /** Human-readable campaign name from the transition event. */
  transitionCampaignName: string | null;
  lastError: {
    message: string;
    recoverable: boolean;
    status?: number;
    delayMs?: number;
    /** Monotonic id stamped when the retry event arrives. Used by the modal
     *  to reset its countdown even if status/delayMs are identical to the
     *  previous retry (the backoff caps at 12s, so successive attempts
     *  routinely look identical). */
    attemptId?: number;
  } | null;
  /** Per-character modeline text (character name → status string). */
  modelines: Record<string, string>;
  /** Per-character resource display keys. */
  displayResources: Record<string, string[]>;
  /** Per-character resource values: character → key → value. */
  resourceValues: Record<string, Record<string, string>>;
}

export function initialClientState(): ClientState {
  return {
    narrativeLines: [],
    currentTurn: null,
    activeChoices: null,
    engineState: null,
    engineStateSince: null,
    toolGlyphs: [],
    variant: "exploration",
    mode: "play",
    stateSnapshot: null,
    sessionEnded: false,
    sessionStale: false,
    transitionCampaignId: null,
    transitionCampaignName: null,
    lastError: null,
    modelines: {},
    displayResources: {},
    resourceValues: {},
  };
}

// --- Event dispatch ---

export type StateUpdater = (fn: (prev: ClientState) => ClientState) => void;

/**
 * Event types that prove the engine is making forward progress on the
 * agent loop. Receiving any of these means an in-flight API retry has
 * resolved, so the recoverable `lastError` (and the connection-issue
 * modal it drives) should clear — even if the resolution didn't
 * produce a narrative chunk (e.g., a successful choice-generator
 * subagent call emits `choices:presented`, not `narrative:chunk`,
 * and would otherwise leave the modal stuck).
 *
 * Allowlist (not an exclude list of `error` + `discord:presence`)
 * because new event types should default to *not* clearing the modal:
 * silently dismissing a retry overlay because some unrelated UI-side
 * event arrived is worse than leaving it open one event longer.
 */
const PROGRESS_EVENT_TYPES: ReadonlySet<ServerEvent["type"]> = new Set([
  "narrative:chunk",
  "narrative:complete",
  "turn:opened",
  "turn:updated",
  "turn:committed",
  "turn:resolved",
  "choices:presented",
  "choices:cleared",
  "activity:update",
  "state:snapshot",
  "session:mode",
  "session:ended",
  "session:transition",
]);

/**
 * Create an event handler that dispatches server events to state updates.
 * Pass this as the `onEvent` callback to WsClient.
 */
export function createEventHandler(update: StateUpdater): (event: ServerEvent) => void {
  return (event: ServerEvent) => {
    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      update((prev) =>
        prev.lastError?.recoverable ? { ...prev, lastError: null } : prev,
      );
    }

    switch (event.type) {
      case "narrative:chunk":
        handleNarrativeChunk(event, update);
        break;
      case "narrative:complete":
        handleNarrativeComplete(event, update);
        break;
      case "turn:opened":
        handleTurnOpened(event, update);
        break;
      case "turn:updated":
        handleTurnUpdated(event, update);
        break;
      case "turn:committed":
        handleTurnCommitted(event, update);
        break;
      case "turn:resolved":
        handleTurnResolved(event, update);
        break;
      case "choices:presented":
        handleChoicesPresented(event, update);
        break;
      case "choices:cleared":
        handleChoicesCleared(event, update);
        break;
      case "activity:update":
        handleActivityUpdate(event, update);
        break;
      case "state:snapshot":
        handleStateSnapshot(event, update);
        break;
      case "session:mode":
        handleSessionMode(event, update);
        break;
      case "session:ended":
        handleSessionEnded(event, update);
        break;
      case "session:transition": {
        // Clear state that could trigger stale detection before the
        // app's useEffect runs and reconnects the WebSocket.
        //
        // engineState becomes "starting_session" (not null) so the activity
        // line keeps spinning across the WS reconnect and the long first
        // DM call. Without this the UI reads as "control returned to player"
        // for 60-90s while the DM agent thinks silently.
        const transition = event.data as { campaignId: string; campaignName?: string };
        update((prev) => ({
          ...prev,
          transitionCampaignId: transition.campaignId,
          transitionCampaignName: transition.campaignName ?? null,
          stateSnapshot: null,
          currentTurn: null,
          activeChoices: null,
          engineState: "starting_session",
          engineStateSince: Date.now(),
          toolGlyphs: [],
        }));
        break;
      }
      case "error":
        handleError(event, update);
        break;
    }
  };
}

// --- Individual handlers ---

/**
 * Check whether the first DM chunk after player input needs a turn separator.
 * Walks backwards through narrative lines, skipping spacers and empty DM lines
 * (from the optimistic insert). Returns true if the last substantive line is a
 * player line with no separator already between it and the current position.
 */
function shouldInjectDmSeparator(lines: NarrativeLine[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind === "spacer") continue;
    if (line.kind === "dm" && line.text === "") continue;
    // Skip dev/system lines (e.g. verbose tool logs) — they can appear
    // between the player line and the first DM chunk without invalidating
    // the need for a separator.
    if (line.kind === "dev" || line.kind === "system") continue;
    return line.kind === "player";
  }
  return false;
}

/**
 * Reconstruct the rendered narrative shape (with turn separators) from a
 * flat dm/player line sequence — used when handleStateSnapshot replaces
 * the local log with the server's authoritative committed transcript.
 *
 * Mirrors the per-chunk separator injection that happens during live
 * streaming so the rendered output looks identical whether the lines
 * arrived live or via snapshot replace. Spacers between turns aren't
 * recreated (they're added by handleNarrativeComplete during live play
 * and by appendDelta on intra-paragraph newlines, neither of which
 * applies to a one-shot replace) — empty dm lines in the source serve
 * the same paragraph-boundary role.
 */
function withTurnSeparators(
  source: readonly { kind: "dm" | "player"; text: string }[],
): NarrativeLine[] {
  const out: NarrativeLine[] = [];
  for (const line of source) {
    if (line.kind === "dm" && shouldInjectDmSeparator(out)) {
      out.push({ kind: "separator", text: "---" });
    }
    out.push(line);
  }
  return out;
}

function handleNarrativeChunk(event: NarrativeChunkEvent, update: StateUpdater): void {
  const { text, kind } = event.data;
  const lineKind = (kind ?? "dm") as NarrativeLine["kind"];

  update((prev) => {
    let lines = prev.narrativeLines;

    // Inject a turn separator before the first DM chunk after player input
    if (lineKind === "dm" && shouldInjectDmSeparator(lines)) {
      lines = [
        ...lines,
        { kind: "separator" as const, text: "---" },
      ];
    }

    return {
      ...prev,
      narrativeLines: appendDelta(lines, text, lineKind),
    };
  });
}

function handleNarrativeComplete(_event: NarrativeCompleteEvent, update: StateUpdater): void {
  // Narrative is already accumulated via chunks. Complete is a flush signal.
  // Add a spacer line after DM output.
  update((prev) => ({
    ...prev,
    narrativeLines: [...prev.narrativeLines, { kind: "spacer" as const, text: "" }],
  }));
}

function handleTurnOpened(event: TurnOpenedEvent, update: StateUpdater): void {
  update((prev) => {
    const incoming = event.data;
    const prevTurn = prev.currentTurn;

    // Detect campaign mismatch (backend switched to a different session)
    if (prevTurn && incoming.campaignId !== prevTurn.campaignId) {
      return { ...prev, sessionStale: true };
    }

    return {
      ...prev,
      currentTurn: incoming,
      lastError: null,
    };
  });
}

function handleTurnUpdated(event: TurnUpdatedEvent, update: StateUpdater): void {
  const { contribution } = event.data;

  update((prev) => {
    // Show other players' contributions as narrative lines
    if (contribution.source === "client") {
      const playerLine: NarrativeLine = {
        kind: "player",
        text: `[${contribution.playerId}] ${contribution.text}`,
      };
      return {
        ...prev,
        narrativeLines: [...prev.narrativeLines, playerLine],
      };
    }
    return prev;
  });
}

function handleTurnCommitted(_event: TurnCommittedEvent, update: StateUpdater): void {
  update((prev) => ({
    ...prev,
    currentTurn: prev.currentTurn
      ? { ...prev.currentTurn, status: "committed" as const }
      : null,
  }));
}

function handleTurnResolved(_event: TurnResolvedEvent, update: StateUpdater): void {
  update((prev) => ({
    ...prev,
    currentTurn: null,
  }));
}

function handleChoicesPresented(event: ChoicesPresentedEvent, update: StateUpdater): void {
  update((prev) => ({
    ...prev,
    activeChoices: event.data,
  }));
}

function handleChoicesCleared(_event: ChoicesClearedEvent, update: StateUpdater): void {
  update((prev) => ({
    ...prev,
    activeChoices: null,
  }));
}

function handleActivityUpdate(event: ActivityUpdateEvent, update: StateUpdater): void {
  const data = event.data as Record<string, unknown>;
  const { engineState, toolStarted } = data;

  // tui:* engineState values are data carriers (TUI command payloads riding
  // on the activity:update channel), not real engine state transitions. They
  // must not override engineState — otherwise the activity indicator briefly
  // drops to an unmapped state during every TUI command, blanking the
  // full-height activity line label and the standard-tier modeline glyph.
  const isTuiPayload = typeof engineState === "string" && engineState.startsWith("tui:");
  const incomingState = isTuiPayload ? undefined : (engineState as string | undefined);

  update((prev) => {
    // Accumulate tool glyphs for the turn (don't remove on end — they persist visually)
    let glyphs = prev.toolGlyphs;
    if (toolStarted) {
      const tg = getToolGlyph(toolStarted as string);
      if (tg) glyphs = [...glyphs, tg];
    }

    // Clear glyphs at two natural turn boundaries:
    //   1. End of turn — engine transitions to "waiting_input" or "idle".
    //      Glyphs belong to the turn that just ended; they should not bleed
    //      into the player's input window. (This mattered less before
    //      ActivityLine learned to render glyphs without a label, because
    //      the row was hidden during idle states. Now it stays visible, so
    //      we have to clear explicitly.)
    //   2. Start of next turn — entering "dm_thinking" from an idle state.
    //      Belt-and-suspenders: covers cases where the engine skips straight
    //      to thinking without an explicit waiting_input event.
    // "starting_session" counts as idle — the first dm_thinking after a
    // setup→game handoff is the start of a fresh turn.
    // tool_running → dm_thinking transitions within a turn must NOT clear.
    const newState = incomingState ?? prev.engineState;
    const wasIdle = !prev.engineState
      || prev.engineState === "waiting_input"
      || prev.engineState === "starting_session";
    if (incomingState === "waiting_input" || incomingState === "idle") {
      glyphs = [];
    } else if (incomingState === "dm_thinking" && wasIdle) {
      glyphs = [];
    }

    // Stamp engineStateSince whenever engineState transitions to a new value
    // so ActivityLine can render elapsed-time hints during long waits.
    const stateChanged = newState !== prev.engineState;
    let next = {
      ...prev,
      engineState: newState,
      engineStateSince: stateChanged
        ? (newState ? Date.now() : null)
        : prev.engineStateSince,
      toolGlyphs: glyphs,
    };

    // Handle embedded TUI command payloads (engineState carries the tui:*
    // discriminator only as routing metadata — the actual engine state was
    // preserved above).
    const tuiType = isTuiPayload ? (engineState as string).slice(4) : null;

    if (tuiType === "update_modeline") {
      const character = data.character as string | undefined;
      const text = data.text as string | undefined;
      if (character && text !== undefined) {
        next = { ...next, modelines: { ...next.modelines, [character]: text } };
      }
    } else if (tuiType === "set_display_resources") {
      const character = data.character as string | undefined;
      const resources = data.resources as string[] | undefined;
      if (character && resources) {
        next = { ...next, displayResources: { ...next.displayResources, [character]: resources } };
      }
    } else if (tuiType === "set_resource_values") {
      const character = data.character as string | undefined;
      const values = data.values as Record<string, string> | undefined;
      if (character && values) {
        const prevValues = next.resourceValues[character] ?? {};
        next = { ...next, resourceValues: { ...next.resourceValues, [character]: { ...prevValues, ...values } } };
      }
    }

    return next;
  });
}

function handleStateSnapshot(event: StateSnapshotEvent, update: StateUpdater): void {
  const snapshot = event.data as StateSnapshot;
  update((prev) => {
    // Detect campaign mismatch on reconnect
    const prevId = prev.stateSnapshot?.campaignId;
    if (prevId && snapshot.campaignId && prevId !== snapshot.campaignId) {
      return { ...prev, sessionStale: true };
    }

    return {
      ...prev,
      stateSnapshot: snapshot,
      mode: snapshot.mode ?? prev.mode,
      variant: (snapshot.variant as StyleVariant) ?? prev.variant,
      // Hydrate resources and modelines from snapshot so they're available
      // immediately, not just after the first TUI command update
      displayResources: snapshot.displayResources ?? prev.displayResources,
      resourceValues: snapshot.resourceValues ?? prev.resourceValues,
      modelines: snapshot.modelines ?? prev.modelines,
      // Authoritative transcript replace, when the server includes one.
      // Sent on connect (so reconnecting clients see history) and on retry
      // rollback (to discard a partial DM stream that's about to be
      // re-issued). Snapshots that omit narrativeLines preserve whatever
      // we've already accumulated, so per-turn snapshots don't clobber
      // in-flight stream deltas. The server only carries dm/player lines;
      // we re-derive turn separators here so the post-replace rendering
      // matches what the live-streaming path produces.
      narrativeLines: snapshot.narrativeLines
        ? withTurnSeparators(snapshot.narrativeLines)
        : prev.narrativeLines,
    };
  });
}

function handleSessionMode(event: SessionModeEvent, update: StateUpdater): void {
  const { mode, variant } = event.data;
  update((prev) => ({
    ...prev,
    mode: mode as ClientState["mode"],
    variant: (variant as StyleVariant) ?? prev.variant,
  }));
}

function handleSessionEnded(_event: SessionEndedEvent, update: StateUpdater): void {
  update((prev) => ({
    ...prev,
    sessionEnded: true,
    currentTurn: null,
    activeChoices: null,
    engineState: null,
    toolGlyphs: [],
  }));
}

function handleError(event: ErrorEvent, update: StateUpdater): void {
  update((prev) => ({
    ...prev,
    lastError: {
      message: event.data.message,
      recoverable: event.data.recoverable,
      status: event.data.status,
      delayMs: event.data.delayMs,
      attemptId: event.data.recoverable
        ? (prev.lastError?.attemptId ?? 0) + 1
        : undefined,
    },
  }));
}
