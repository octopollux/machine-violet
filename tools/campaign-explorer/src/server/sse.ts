import type { Request, Response } from "express";
import type { SSEEvent } from "../shared/protocol.js";

type SSEClient = {
  res: Response;
  id: number;
};

let nextId = 0;
const clients: SSEClient[] = [];

/** Express handler for GET /api/events (SSE endpoint). */
export function sseHandler(_req: Request, res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  const client: SSEClient = { res, id: nextId++ };
  clients.push(client);

  _req.on("close", () => {
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
  });
}

/** Broadcast an SSE event to all connected clients. */
export function broadcast(event: SSEEvent): void {
  const data = JSON.stringify(event);
  for (const client of clients) {
    client.res.write(`event: ${event.type}\ndata: ${data}\n\n`);
  }
}

/** Get the number of connected SSE clients (for diagnostics). */
export function clientCount(): number {
  return clients.length;
}
