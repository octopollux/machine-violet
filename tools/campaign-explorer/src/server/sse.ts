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
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.status(200);
  res.flushHeaders();

  // Keep-alive comment every 30s to prevent proxy/browser timeout
  const keepAlive = setInterval(() => {
    res.write(":keepalive\n\n");
  }, 30_000);

  const client: SSEClient = { res, id: nextId++ };
  clients.push(client);
  console.log(`SSE client ${client.id} connected (${clients.length} total)`);

  _req.on("close", () => {
    clearInterval(keepAlive);
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
  });
}

/** Broadcast an SSE event to all connected clients. */
export function broadcast(event: SSEEvent): void {
  if (clients.length === 0) return;
  const data = JSON.stringify(event);
  console.log(`SSE → ${clients.length} client(s): ${event.type} ${event.type === "file-change" ? event.relativePath : ""}`);
  for (const client of clients) {
    client.res.write(`event: ${event.type}\ndata: ${data}\n\n`);
  }
}

/** Get the number of connected SSE clients (for diagnostics). */
export function clientCount(): number {
  return clients.length;
}
