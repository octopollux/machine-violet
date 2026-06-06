/**
 * Dev-only routes — session-tape recorder readback (Tier-2 goldens).
 *
 * `GET /tape` returns the tape recorded so far this process. These routes are
 * registered by `createServer` ONLY when `MV_TAPE_MODE=record`, so in replay or
 * production the route doesn't exist at all (the gate keeps `getRecordedTape`'s
 * own null→404 path for the case where recording is on but nothing's captured
 * yet).
 *
 * The test-harness recorder pulls the tape here AFTER a live pilot finishes,
 * rather than having the engine flush on exit: the harness force-kills the
 * whole process tree (`taskkill /F` on Windows) so exit handlers don't run.
 * See `packages/engine/src/providers/tape-mode.ts`.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { getRecordedTape } from "../../providers/tape-mode.js";

export const devRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {
  // No response schema on purpose: a tape is a deep, open-ended object and a
  // fast-json-stringify response schema would silently drop unknown fields,
  // corrupting the golden. Omitting `response` falls back to JSON.stringify,
  // which serializes the tape verbatim.
  server.get("/tape", { schema: { tags: ["Dev"] } }, async (_request, reply) => {
    const tape = getRecordedTape();
    if (!tape) {
      return reply
        .status(404)
        .send({ error: "Not recording (MV_TAPE_MODE != record) or no tape captured yet." });
    }
    return tape;
  });
};
