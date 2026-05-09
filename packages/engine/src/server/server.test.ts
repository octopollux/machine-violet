import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createServer } from "./server.js";

describe("engine server", () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = await createServer({ campaignsDir: "/tmp/test-campaigns", configDir: "/tmp/test-config" });
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

describe("createServer stdio mirror", () => {
  let tempRoot: string;
  let savedStdoutWrite: typeof process.stdout.write;
  let savedStderrWrite: typeof process.stderr.write;
  let savedStdoutTTY: boolean | undefined;
  let savedNodeEnv: string | undefined;
  let server: FastifyInstance | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "mv-server-mirror-"));
    savedStdoutWrite = process.stdout.write;
    savedStderrWrite = process.stderr.write;
    savedStdoutTTY = process.stdout.isTTY;
    savedNodeEnv = process.env.NODE_ENV;
    // The mirror is short-circuited when NODE_ENV === "test", so flip it
    // to exercise the real branch.
    process.env.NODE_ENV = "development";
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
    if (savedStdoutTTY === undefined) {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      process.stdout.isTTY = savedStdoutTTY;
    }
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("wraps stdout.write when stdout is not a TTY (headless run)", async () => {
    process.stdout.isTTY = false;
    const before = process.stdout.write;
    server = await createServer({
      campaignsDir: join(tempRoot, "campaigns"),
      configDir: tempRoot,
    });
    expect(process.stdout.write).not.toBe(before);
  });

  it("does not wrap stdout.write when stdout is a TTY (launcher / interactive)", async () => {
    process.stdout.isTTY = true;
    const before = process.stdout.write;
    server = await createServer({
      campaignsDir: join(tempRoot, "campaigns"),
      configDir: tempRoot,
    });
    expect(process.stdout.write).toBe(before);
  });
});
