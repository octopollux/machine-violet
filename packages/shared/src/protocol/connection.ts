/**
 * Connection identity types for WebSocket clients.
 */
import { Type, type Static } from "@sinclair/typebox";

export const PlayerRole = Type.Object({
  role: Type.Literal("player"),
  playerId: Type.String(),
});

export const SpectatorRole = Type.Object({
  role: Type.Literal("spectator"),
});

export const ConnectionIdentity = Type.Union([PlayerRole, SpectatorRole]);

export type PlayerRole = Static<typeof PlayerRole>;
export type SpectatorRole = Static<typeof SpectatorRole>;
export type ConnectionIdentity = Static<typeof ConnectionIdentity>;
