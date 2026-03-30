/**
 * Maps WebSocket server events to client-side state updates.
 *
 * This is the client-side counterpart of the engine's bridge.ts.
 * The engine translates EngineCallbacks → ServerEvents, and this
 * module translates ServerEvents → React state updates.
 */
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
  activeTools: string[];
  variant: StyleVariant;
  mode: "play" | "ooc" | "dev" | "setup";
  stateSnapshot: StateSnapshot | null;
  sessionEnded: boolean;
  lastError: { message: string; recoverable: boolean } | null;
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
    activeTools: [],
    variant: "exploration",
    mode: "play",
    stateSnapshot: null,
    sessionEnded: false,
    lastError: null,
    modelines: {},
    displayResources: {},
    resourceValues: {},
  };
}

// --- Event dispatch ---

export type StateUpdater = (fn: (prev: ClientState) => ClientState) => void;

/**
 * Create an event handler that dispatches server events to state updates.
 * Pass this as the `onEvent` callback to WsClient.
 */
export function createEventHandler(update: StateUpdater): (event: ServerEvent) => void {
  return (event: ServerEvent) => {
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
      case "error":
        handleError(event, update);
        break;
    }
  };
}

// --- Individual handlers ---

function handleNarrativeChunk(event: NarrativeChunkEvent, update: StateUpdater): void {
  const { text, kind } = event.data;
  const lineKind = (kind ?? "dm") as NarrativeLine["kind"];

  update((prev) => ({
    ...prev,
    // Use the same appendDelta logic as the monolith — handles newline
    // splitting, spacer insertion between paragraphs, and \n\n paragraph
    // boundary detection with the tentative-spacer promotion pattern.
    narrativeLines: appendDelta(prev.narrativeLines, text, lineKind),
  }));
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
  update((prev) => ({
    ...prev,
    currentTurn: event.data,
    lastError: null,
  }));
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
  const { engineState, toolStarted, toolEnded } = data;

  update((prev) => {
    let tools = prev.activeTools;
    if (toolStarted) {
      tools = [...tools, toolStarted as string];
    }
    if (toolEnded) {
      tools = tools.filter((t) => t !== toolEnded);
    }

    let next = {
      ...prev,
      engineState: (engineState as string) ?? prev.engineState,
      activeTools: tools,
    };

    // Handle embedded TUI command payloads
    const tuiType = typeof engineState === "string" && engineState.startsWith("tui:")
      ? engineState.slice(4)
      : null;

    if (tuiType === "update_modeline") {
      const character = data.character as string | undefined;
      const text = data.text as string | undefined;
      if (character && text !== undefined) {
        next = { ...next, modelines: { ...next.modelines, [character]: text } };
      }
    } else if (tuiType === "set_display_resources") {
      const resources = data.resources as Record<string, string[]> | undefined;
      if (resources) {
        next = { ...next, displayResources: resources };
      }
    } else if (tuiType === "set_resource_values") {
      const values = data.values as Record<string, Record<string, string>> | undefined;
      if (values) {
        next = { ...next, resourceValues: { ...next.resourceValues, ...values } };
      }
    }

    return next;
  });
}

function handleStateSnapshot(event: StateSnapshotEvent, update: StateUpdater): void {
  const snapshot = event.data as StateSnapshot;
  update((prev) => ({
    ...prev,
    stateSnapshot: snapshot,
    mode: snapshot.mode ?? prev.mode,
    variant: (snapshot.variant as StyleVariant) ?? prev.variant,
    // Hydrate resources and modelines from snapshot so they're available
    // immediately, not just after the first TUI command update
    displayResources: snapshot.displayResources ?? prev.displayResources,
    resourceValues: snapshot.resourceValues ?? prev.resourceValues,
    modelines: snapshot.modelines ?? prev.modelines,
  }));
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
    activeTools: [],
  }));
}

function handleError(event: ErrorEvent, update: StateUpdater): void {
  update((prev) => ({
    ...prev,
    lastError: { message: event.data.message, recoverable: event.data.recoverable },
  }));
}
