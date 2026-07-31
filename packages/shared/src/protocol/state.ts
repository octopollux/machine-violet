/**
 * State snapshot schema — sent on WebSocket connect and after scene transitions.
 *
 * This is the full state the frontend needs to render the game. The frontend
 * is stateless across sessions; this snapshot is the only source of truth.
 */
import { Type, type Static } from "@sinclair/typebox";

/**
 * Versioned UI/resource state captured at a durable transcript boundary.
 *
 * Checkpoints are full snapshots rather than deltas so any individual entry is
 * independently useful to scrollback and transcript-export consumers.
 */
export const TranscriptStateCheckpoint = Type.Object({
  version: Type.Literal(1),
  modelines: Type.Record(Type.String(), Type.String()),
  displayResources: Type.Record(Type.String(), Type.Array(Type.String())),
  resourceValues: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
});

export type TranscriptStateCheckpoint = Static<typeof TranscriptStateCheckpoint>;

/** Origin of a choice presentation shown during gameplay. */
export const TranscriptChoiceSource = Type.Union([
  Type.Literal("present_choices"),
  Type.Literal("suggestion_generator"),
]);

export type TranscriptChoiceSource = Static<typeof TranscriptChoiceSource>;

/**
 * The exact choice payload shown to the player. Prompt, choices, and
 * descriptions are preserved verbatim, including Machine Violet formatting
 * tags; the stable ID links the later response without comparing display text.
 */
export const TranscriptChoicePresentation = Type.Object({
  id: Type.String(),
  source: TranscriptChoiceSource,
  prompt: Type.String(),
  choices: Type.Array(Type.String()),
  descriptions: Type.Optional(Type.Array(Type.String())),
});

export type TranscriptChoicePresentation = Static<typeof TranscriptChoicePresentation>;

/** Structured provenance sent back when the player responds to a choice UI. */
export const TranscriptChoiceResponse = Type.Union([
  Type.Object({
    presentationId: Type.String(),
    kind: Type.Literal("option"),
    /** Zero-based index into the presentation's ordered `choices` array. */
    optionIndex: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    presentationId: Type.String(),
    kind: Type.Literal("custom"),
  }),
]);

export type TranscriptChoiceResponse = Static<typeof TranscriptChoiceResponse>;

/** Accepted player response to a previously presented choice set. */
export const TranscriptChoiceResolution = Type.Intersect([
  TranscriptChoiceResponse,
  Type.Object({
    playerId: Type.String(),
    /** Plain contribution text recorded in the visible transcript. */
    contributionText: Type.String(),
  }),
]);

export type TranscriptChoiceResolution = Static<typeof TranscriptChoiceResolution>;

/**
 * Append-only, invisible metadata interleaved with the visible transcript.
 * More event kinds can be added without inventing another display-log marker.
 */
export const TranscriptMetadataEvent = Type.Union([
  Type.Object({
    type: Type.Literal("state_checkpoint"),
    state: TranscriptStateCheckpoint,
  }),
  Type.Object({
    type: Type.Literal("choices_presented"),
    presentation: TranscriptChoicePresentation,
  }),
  Type.Object({
    type: Type.Literal("choice_resolved"),
    resolution: TranscriptChoiceResolution,
  }),
]);

export type TranscriptMetadataEvent = Static<typeof TranscriptMetadataEvent>;

export const StateSnapshot = Type.Object({
  /** Campaign identity */
  campaignId: Type.String(),
  campaignName: Type.String(),
  system: Type.Optional(Type.String()),

  /** Player roster and active turn */
  players: Type.Array(Type.Object({
    name: Type.String(),
    character: Type.String(),
    type: Type.Union([Type.Literal("human"), Type.Literal("ai")]),
    color: Type.Optional(Type.String()),
  })),
  activePlayerIndex: Type.Number(),

  /** Per-character resource display */
  displayResources: Type.Record(Type.String(), Type.Array(Type.String())),
  resourceValues: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),

  /** Modeline statuses (character → status text) */
  modelines: Type.Record(Type.String(), Type.String()),

  /** Choice modal currently awaiting a response, if any. */
  activeChoices: Type.Optional(TranscriptChoicePresentation),

  /** Theme / visual state */
  themeName: Type.Optional(Type.String()),
  variant: Type.Optional(Type.String()),
  keyColor: Type.Optional(Type.String()),

  /** Engine state */
  engineState: Type.Optional(Type.String()),

  /** Session mode */
  mode: Type.Union([
    Type.Literal("play"),
    Type.Literal("ooc"),
    Type.Literal("dev"),
    Type.Literal("setup"),
  ]),

  /** Cost tracking */
  cost: Type.Optional(Type.Unknown()),

  /** Scene info */
  sceneNumber: Type.Optional(Type.Number()),
  scenePrecis: Type.Optional(Type.String()),

  /**
   * One-shot: present only in the first snapshot after a session resume where
   * the previous session ended cleanly. The client renders SessionRecapModal
   * and does not need to ACK — the server clears the pending flag as it emits.
   */
  sessionRecap: Type.Optional(Type.Object({
    id: Type.String(),
    lines: Type.Array(Type.String()),
  })),

  /**
   * Authoritative committed transcript (DM + player lines only).
   *
   * When present, the client REPLACES its accumulated narrative log with
   * these lines. When absent, the client's existing narrative is preserved.
   *
   * The server populates this on connect (so reconnecting clients see
   * history) and on retry rollback (to discard a partial DM stream that's
   * about to be re-issued). It is intentionally omitted from per-turn
   * snapshots so live-streamed deltas aren't clobbered.
   *
   * Only `dm`, `player`, and invisible `metadata` kinds cross the wire;
   * turn separators are re-derived by the client from kind transitions so
   * post-replace rendering matches live streaming, while system/dev lines
   * and any spacers from a prior live stream are dropped on replace (they're
   * presentation-only and not worth round-tripping).
   *
   * Each text entry is one rendered line — multi-paragraph DM/player text is
   * split on `\n` server-side so the shape matches what `appendDelta`
   * produces during live streaming. Empty text entries represent paragraph
   * boundaries; metadata entries consume zero rows.
   */
  narrativeLines: Type.Optional(Type.Array(Type.Union([
    Type.Object({
      kind: Type.Literal("dm"),
      text: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("player"),
      text: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("metadata"),
      text: Type.Literal(""),
      event: TranscriptMetadataEvent,
    }),
  ]))),
});

export type StateSnapshot = Static<typeof StateSnapshot>;
