/**
 * WebSocket event types (server → client).
 *
 * Each event has a `type` discriminant and a `data` payload.
 * Maps from EngineCallbacks to wire format.
 */
import { Type, type Static } from "@sinclair/typebox";
import { TurnContribution, Turn } from "./turn.js";
import { Modal } from "./modals.js";

// --- Narrative ---

export const NarrativeChunkEvent = Type.Object({
  type: Type.Literal("narrative:chunk"),
  data: Type.Object({
    text: Type.String(),
    speaker: Type.Optional(Type.String()),
    kind: Type.Optional(Type.Union([
      Type.Literal("dm"),
      Type.Literal("player"),
      Type.Literal("system"),
      Type.Literal("dev"),
    ])),
  }),
});

export const NarrativeCompleteEvent = Type.Object({
  type: Type.Literal("narrative:complete"),
  data: Type.Object({
    text: Type.String(),
    playerAction: Type.Optional(Type.String()),
  }),
});

// --- Turn lifecycle ---

export const TurnOpenedEvent = Type.Object({
  type: Type.Literal("turn:opened"),
  data: Turn,
});

export const TurnUpdatedEvent = Type.Object({
  type: Type.Literal("turn:updated"),
  data: Type.Object({
    turnId: Type.String(),
    contribution: TurnContribution,
  }),
});

export const TurnCommittedEvent = Type.Object({
  type: Type.Literal("turn:committed"),
  data: Type.Object({
    turnId: Type.String(),
  }),
});

export const TurnResolvedEvent = Type.Object({
  type: Type.Literal("turn:resolved"),
  data: Type.Object({
    turnId: Type.String(),
  }),
});

// --- Modals ---

export const ModalShowEvent = Type.Object({
  type: Type.Literal("modal:show"),
  data: Modal,
});

export const ModalDismissEvent = Type.Object({
  type: Type.Literal("modal:dismiss"),
  data: Type.Object({
    id: Type.String(),
  }),
});

// --- Activity / tool tracking ---

export const ActivityUpdateEvent = Type.Object({
  type: Type.Literal("activity:update"),
  data: Type.Object({
    engineState: Type.Optional(Type.String()),
    toolStarted: Type.Optional(Type.String()),
    toolEnded: Type.Optional(Type.String()),
  }),
});

// --- State ---

export const StateSnapshotEvent = Type.Object({
  type: Type.Literal("state:snapshot"),
  /** Full game state — typed loosely to avoid duplicating the full GameState schema.
   *  In practice this is a serialized GameState + scene + cost data. */
  data: Type.Unknown(),
});

// --- Session ---

export const SessionModeEvent = Type.Object({
  type: Type.Literal("session:mode"),
  data: Type.Object({
    mode: Type.Union([
      Type.Literal("play"),
      Type.Literal("ooc"),
      Type.Literal("dev"),
      Type.Literal("setup"),
    ]),
    variant: Type.Optional(Type.String()),
  }),
});

export const SessionEndedEvent = Type.Object({
  type: Type.Literal("session:ended"),
  data: Type.Object({
    summary: Type.Optional(Type.String()),
    /** Token breakdown — typed loosely here, full type in types/engine.ts. */
    cost: Type.Optional(Type.Unknown()),
  }),
});

// --- Error ---

export const ErrorEvent = Type.Object({
  type: Type.Literal("error"),
  data: Type.Object({
    message: Type.String(),
    recoverable: Type.Boolean(),
    status: Type.Optional(Type.Number()),
    delayMs: Type.Optional(Type.Number()),
  }),
});

// --- Union of all server events ---

export const ServerEvent = Type.Union([
  NarrativeChunkEvent,
  NarrativeCompleteEvent,
  TurnOpenedEvent,
  TurnUpdatedEvent,
  TurnCommittedEvent,
  TurnResolvedEvent,
  ModalShowEvent,
  ModalDismissEvent,
  ActivityUpdateEvent,
  StateSnapshotEvent,
  SessionModeEvent,
  SessionEndedEvent,
  ErrorEvent,
]);

export type NarrativeChunkEvent = Static<typeof NarrativeChunkEvent>;
export type NarrativeCompleteEvent = Static<typeof NarrativeCompleteEvent>;
export type TurnOpenedEvent = Static<typeof TurnOpenedEvent>;
export type TurnUpdatedEvent = Static<typeof TurnUpdatedEvent>;
export type TurnCommittedEvent = Static<typeof TurnCommittedEvent>;
export type TurnResolvedEvent = Static<typeof TurnResolvedEvent>;
export type ModalShowEvent = Static<typeof ModalShowEvent>;
export type ModalDismissEvent = Static<typeof ModalDismissEvent>;
export type ActivityUpdateEvent = Static<typeof ActivityUpdateEvent>;
export type StateSnapshotEvent = Static<typeof StateSnapshotEvent>;
export type SessionModeEvent = Static<typeof SessionModeEvent>;
export type SessionEndedEvent = Static<typeof SessionEndedEvent>;
export type ErrorEvent = Static<typeof ErrorEvent>;
export type ServerEvent = Static<typeof ServerEvent>;
