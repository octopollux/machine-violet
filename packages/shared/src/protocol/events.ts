/**
 * WebSocket event types (server → client).
 *
 * Each event has a `type` discriminant and a `data` payload.
 * Maps from EngineCallbacks to wire format.
 */
import { Type, type Static } from "@sinclair/typebox";
import { TurnContribution, Turn } from "./turn.js";
import { UsageStatus } from "./usage.js";

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

// --- Provider usage (remaining session quota) ---

export const UsageUpdateEvent = Type.Object({
  type: Type.Literal("usage:update"),
  data: UsageStatus,
});

// --- Error ---

/**
 * Three-tier error taxonomy. The discriminant tells the client *what UX to
 * show*, not what caused the error — the same `category` can come from many
 * underlying conditions. Decided server-side; never inferred from
 * `message`. Keep this a closed union so new bucket-introducing PRs have to
 * touch this type (and therefore the matching client handler).
 *
 *  - `retryable` (default for backward compat) — transient (429, network
 *    blip). Server will retry; player just waits. Existing retry overlay.
 *  - `session-fatal-recoverable` — this session is done (auth expired,
 *    forbidden model, classifier refusal, etc.) but the process is fine.
 *    Player must take action (re-auth, change model, fix config) and start
 *    a new session. Client drops to main menu, shows the message verbatim
 *    in a red banner.
 *  - `process-fatal` — process can't continue. Existing error screen / hard
 *    exit. Reserved for catastrophic conditions; rarely emitted today.
 */
export const ErrorCategory = Type.Union([
  Type.Literal("retryable"),
  Type.Literal("session-fatal-recoverable"),
  Type.Literal("process-fatal"),
]);

export const ErrorEvent = Type.Object({
  type: Type.Literal("error"),
  data: Type.Object({
    message: Type.String(),
    recoverable: Type.Boolean(),
    status: Type.Optional(Type.Number()),
    delayMs: Type.Optional(Type.Number()),
    /** Three-tier discriminator. Optional so pre-existing callsites that
     *  don't set it behave as before. Absent ↔ `retryable`. */
    category: Type.Optional(ErrorCategory),
  }),
});

// --- Client → server events ---

/**
 * Client viewport dimensions. Sent on WS connect and on resize.
 * The server tracks dims per WS connection and reports the *floor*
 * (smallest narrativeRows across all connected clients) to the DM's
 * length-steering injection. A user-tunable percentage is applied to
 * the floor before it reaches the DM (see CampaignConfig.dm_turn_length_pct).
 */
export const ClientViewportEvent = Type.Object({
  type: Type.Literal("client:viewport"),
  data: Type.Object({
    columns: Type.Number(),
    rows: Type.Number(),
    /** Usable narrative-area rows (after subtracting UI chrome). */
    narrativeRows: Type.Number(),
  }),
});

export const ClientEvent = Type.Union([
  ClientViewportEvent,
]);

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
  UsageUpdateEvent,
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
export type UsageUpdateEvent = Static<typeof UsageUpdateEvent>;
export type ErrorCategory = Static<typeof ErrorCategory>;
export type ErrorEvent = Static<typeof ErrorEvent>;
export type ServerEvent = Static<typeof ServerEvent>;
export type ClientViewportEvent = Static<typeof ClientViewportEvent>;
export type ClientEvent = Static<typeof ClientEvent>;
