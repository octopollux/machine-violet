/**
 * @machine-violet/engine — entry point.
 *
 * Starts the Fastify HTTP/WS server on localhost.
 * Configure via environment variables:
 *   MV_PORT         — HTTP port (default 7200)
 *   MV_HOST         — Bind address (default 127.0.0.1, localhost-only)
 *   MV_CAMPAIGNS    — Campaign data directory
 */
import { createServer } from "./server/server.js";

const port = Number(process.env.MV_PORT) || 7200;
const host = process.env.MV_HOST ?? "127.0.0.1";
const campaignsDir = process.env.MV_CAMPAIGNS ?? "";

async function main(): Promise<void> {
  const server = await createServer({ port, host, campaignsDir });

  try {
    await server.listen({ port, host });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
