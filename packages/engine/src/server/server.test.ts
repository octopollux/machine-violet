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
    it("starts a session and returns wsUrl", async () => {
      const response = await server.inject({
        method: "POST",
        url: "/campaigns/test-campaign/start",
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.sessionId).toBe("test-campaign");
      expect(body.wsUrl).toBe("/session/ws");
    });

    it("rejects starting a second session", async () => {
      await server.inject({ method: "POST", url: "/campaigns/c1/start" });
      const response = await server.inject({ method: "POST", url: "/campaigns/c2/start" });
      expect(response.statusCode).toBe(409);
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

    it("returns state snapshot when session is active", async () => {
      await server.inject({ method: "POST", url: "/campaigns/test/start" });
      const response = await server.inject({
        method: "GET",
        url: "/session/state",
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty("campaignId");
      expect(body).toHaveProperty("mode", "play");
    });

    it("ends session", async () => {
      await server.inject({ method: "POST", url: "/campaigns/test/start" });
      const response = await server.inject({
        method: "POST",
        url: "/session/end",
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.summary).toBe("Session ended.");

      // Verify session is no longer active
      const stateResp = await server.inject({ method: "GET", url: "/session/state" });
      expect(stateResp.statusCode).toBe(400);
    });
  });
});
