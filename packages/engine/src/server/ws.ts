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

    // Most client→server traffic goes over REST. The one exception is
    // `client:viewport`, which the client emits on connect and on resize
    // so the DM's length-steering hint can adapt to the smallest connected
    // terminal. Unknown messages are logged and dropped.
    socket.on("message", (data: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        server.log.warn({ data: String(data) }, "Unparseable WebSocket message from client");
        return;
      }
      if (
        parsed
        && typeof parsed === "object"
        && (parsed as { type?: unknown }).type === "client:viewport"
      ) {
        const d = (parsed as { data?: unknown }).data;
        if (
          d
          && typeof d === "object"
          && typeof (d as { columns?: unknown }).columns === "number"
          && typeof (d as { rows?: unknown }).rows === "number"
          && typeof (d as { narrativeRows?: unknown }).narrativeRows === "number"
        ) {
          const v = d as { columns: number; rows: number; narrativeRows: number };
          sm.updateClientViewport(socket, {
            columns: v.columns,
            rows: v.rows,
            narrativeRows: v.narrativeRows,
          });
          return;
        }
      }
      server.log.warn({ data: String(data) }, "Unexpected WebSocket message from client");
    });
  });
};
