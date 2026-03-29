/**
 * WebSocket handler for client connections.
 *
 * Clients connect at /session/ws?role=player&player=aldric
 * or /session/ws?role=spectator
 *
 * Localhost-only, no auth. Auth will be added when remote
 * connections are enabled.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { ConnectionIdentity } from "@machine-violet/shared";

export const wsHandler: FastifyPluginAsync = async (server: FastifyInstance) => {
  server.get("/ws", { websocket: true }, (socket, request) => {
    // Parse connection identity from query params
    const role = (request.query as Record<string, string>).role ?? "spectator";
    const playerId = (request.query as Record<string, string>).player;

    let identity: ConnectionIdentity;
    if (role === "player" && playerId) {
      identity = { role: "player", playerId };
    } else {
      identity = { role: "spectator" };
    }

    const sm = server.sessionManager;
    sm.addClient(socket, identity);

    server.log.info(
      { role: identity.role, player: identity.role === "player" ? identity.playerId : undefined },
      "Client connected",
    );

    socket.on("close", () => {
      server.log.info(
        { role: identity.role },
        "Client disconnected",
      );
    });

    // Clients send commands via REST, not WebSocket.
    // This handler is intentionally empty — the WS is server→client only.
    socket.on("message", (data: Buffer) => {
      // Log unexpected messages but don't process them
      server.log.warn({ data: String(data) }, "Unexpected WebSocket message from client");
    });
  });
};
