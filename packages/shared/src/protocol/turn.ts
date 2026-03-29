/**
 * Turn model types for the collaborative turn system.
 *
 * Turns are first-class entities that can be created, contributed to by
 * multiple players (human or AI), and committed to trigger DM processing.
 */
import { Type, type Static } from "@sinclair/typebox";

export const TurnContribution = Type.Object({
  id: Type.String(),
  playerId: Type.String(),
  source: Type.Union([Type.Literal("client"), Type.Literal("engine")]),
  text: Type.String(),
  /** If true, replaces the previous contribution from the same player. */
  amendment: Type.Boolean({ default: false }),
});

export const Turn = Type.Object({
  id: Type.String(),
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("committed"),
    Type.Literal("processing"),
    Type.Literal("resolved"),
  ]),
  /** Human players who can contribute to this turn. */
  activePlayers: Type.Array(Type.String()),
  /** AI players scheduled to run after all humans contribute. */
  aiPlayers: Type.Array(Type.String()),
  contributions: Type.Array(TurnContribution),
  /** auto: single player, commit after first contribution.
   *  all: multi-player, commit when all active players have contributed. */
  commitPolicy: Type.Union([Type.Literal("auto"), Type.Literal("all")]),
});

export type TurnContribution = Static<typeof TurnContribution>;
export type Turn = Static<typeof Turn>;
