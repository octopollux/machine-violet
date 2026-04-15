/**
 * WebSocket event types (server → client).
 *
 * Each event has a `type` discriminant and a `data` payload.
 * Maps from EngineCallbacks to wire format.
 */
import { Type, type Static } from "@sinclair/typebox";
import { TurnContribution, Turn } from "./turn.js";

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

// --- Choices ---

export const ChoicesData = Type.Object({
  id: Type.String(),
  prompt: Type.String(),
  choices: Type.Array(Type.String()),
  descriptions: Type.Optional(Type.Array(Type.String())),
});

export const ChoicesPresentedEvent = Type.Object({
  type: Type.Literal("choices:presented"),
  data: ChoicesData,
});

export const ChoicesClearedEvent = Type.Object({
  type: Type.Literal("choices:cleared"),
  data: Type.Object({}),
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

export const SessionTransitionEvent = Type.Object({
  type: Type.Literal("session:transition"),
  data: Type.Object({
    /** The campaign ID of the newly created campaign to transition into. */
    campaignId: Type.String(),
    /** Human-readable campaign name for immediate display. */
    campaignName: Type.Optional(Type.String()),
  }),
});

// --- Discord rich presence (frontend-local; backend just emits the data) ---

export const DiscordPresenceEvent = Type.Object({
  type: Type.Literal("discord:presence"),
  data: Type.Union([
    Type.Object({
      action: Type.Literal("start"),
      campaignName: Type.String(),
      dmPersona: Type.String(),
    }),
    Type.Object({
      action: Type.Literal("update"),
      details: Type.String(),
    }),
    Type.Object({
      action: Type.Literal("stop"),
    }),
  ]),
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
  ChoicesPresentedEvent,
  ChoicesClearedEvent,
  ActivityUpdateEvent,
  StateSnapshotEvent,
  SessionModeEvent,
  SessionEndedEvent,
  SessionTransitionEvent,
  DiscordPresenceEvent,
  ErrorEvent,
]);

export type NarrativeChunkEvent = Static<typeof NarrativeChunkEvent>;
export type NarrativeCompleteEvent = Static<typeof NarrativeCompleteEvent>;
export type TurnOpenedEvent = Static<typeof TurnOpenedEvent>;
export type TurnUpdatedEvent = Static<typeof TurnUpdatedEvent>;
export type TurnCommittedEvent = Static<typeof TurnCommittedEvent>;
export type TurnResolvedEvent = Static<typeof TurnResolvedEvent>;
export type ChoicesData = Static<typeof ChoicesData>;
export type ChoicesPresentedEvent = Static<typeof ChoicesPresentedEvent>;
export type ChoicesClearedEvent = Static<typeof ChoicesClearedEvent>;
export type ActivityUpdateEvent = Static<typeof ActivityUpdateEvent>;
export type StateSnapshotEvent = Static<typeof StateSnapshotEvent>;
export type SessionModeEvent = Static<typeof SessionModeEvent>;
export type SessionEndedEvent = Static<typeof SessionEndedEvent>;
export type SessionTransitionEvent = Static<typeof SessionTransitionEvent>;
export type DiscordPresenceEvent = Static<typeof DiscordPresenceEvent>;
export type ErrorEvent = Static<typeof ErrorEvent>;
export type ServerEvent = Static<typeof ServerEvent>;
