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

/**
 * Sane terminal-size ceiling for inbound viewport reports. A real
 * terminal won't be wider than a few hundred columns even on the
 * widest monitor — anything larger is either a buggy client or
 * deliberately malformed. Rejecting > MAX_DIM avoids surprises in
 * downstream code that uses these as buffer/budget sizes.
 */
const MAX_DIM = 10_000;

/**
 * Validate a `client:viewport` payload. Returns the normalized dims
 * when every field is a finite positive integer ≤ MAX_DIM and
 * narrativeRows ≤ rows; returns null on any rejection.
 *
 * Hand-rolled rather than TypeBox-compiled because the WS handler
 * already takes the message via untyped JSON.parse and we'd rather not
 * pull TypeBox runtime checking into this path for one event.
 *
 * Exported for unit testing — not part of the public API surface.
 */
export function sanitizeClientViewport(
  d: unknown,
): { columns: number; rows: number; narrativeRows: number } | null {
  if (!d || typeof d !== "object") return null;
  const obj = d as Record<string, unknown>;
  const columns = obj.columns;
  const rows = obj.rows;
  const narrativeRows = obj.narrativeRows;
  if (typeof columns !== "number" || !Number.isInteger(columns) || columns <= 0 || columns > MAX_DIM) return null;
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 0 || rows > MAX_DIM) return null;
  if (typeof narrativeRows !== "number" || !Number.isInteger(narrativeRows) || narrativeRows <= 0 || narrativeRows > MAX_DIM) return null;
  if (narrativeRows > rows) return null;
  return { columns, rows, narrativeRows };
}

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
    // terminal. Unknown or malformed messages are logged and dropped.
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
        const viewport = sanitizeClientViewport(d);
        if (viewport) {
          sm.updateClientViewport(socket, viewport);
          return;
        }
        server.log.warn({ data }, "Rejecting client:viewport with invalid dims");
        return;
      }
      server.log.warn({ data: String(data) }, "Unexpected WebSocket message from client");
    });
  });
};
