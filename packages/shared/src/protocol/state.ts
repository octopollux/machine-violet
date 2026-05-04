/**
 * State snapshot schema — sent on WebSocket connect and after scene transitions.
 *
 * This is the full state the frontend needs to render the game. The frontend
 * is stateless across sessions; this snapshot is the only source of truth.
 */
import { Type, type Static } from "@sinclair/typebox";

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
   * Only `dm` and `player` kinds are tracked server-side; transient kinds
   * (separator, spacer, dev, system) are presentation-only and re-derived
   * by the client from the line sequence.
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
  ]))),
});

export type StateSnapshot = Static<typeof StateSnapshot>;
