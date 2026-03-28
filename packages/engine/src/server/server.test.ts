import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "./server.js";

describe("engine server", () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = await createServer({ campaignsDir: "/tmp/test-campaigns" });
  });

  afterEach(async () => {
    await server.close();
  });

  describe("GET /campaigns", () => {
    it("returns empty campaign list", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/campaigns",
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({ campaigns: [] });
    });
  });

  describe("POST /campaigns/:id/start", () => {
    it("returns 400 when campaign config doesn't exist", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/campaigns/nonexistent/start",
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain("Failed to load campaign config");
    });
  });

  describe("session routes", () => {
    it("rejects requests when no session is active", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/session/state",
      });
      expect(response.statusCode).toBe(400);
    });

    it("POST /session/end returns 400 when no session active", async () => {
      // endSession is a no-op when no session is active, but the
      // preHandler check rejects the request
      const response = await server.inject({
        method: "POST",
        url: "/session/end",
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
