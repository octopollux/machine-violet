import { describe, it, expect, afterEach } from "vitest";
import { KEY_MAP, startAgentSidecar, type SidecarHandle } from "./agent-sidecar.js";
import { initialClientState } from "./event-handler.js";

// ---------------------------------------------------------------------------
// KEY_MAP
// ---------------------------------------------------------------------------

describe("KEY_MAP", () => {
  it("maps all common keys to non-empty strings", () => {
    const required = ["return", "enter", "escape", "tab", "backspace", "up", "down", "left", "right", "home", "end"];
    for (const key of required) {
      expect(KEY_MAP[key], `missing key: ${key}`).toBeTruthy();
    }
  });

  it("maps ctrl+ combos to control characters", () => {
    expect(KEY_MAP["ctrl+c"]).toBe("\x03");
    expect(KEY_MAP["ctrl+d"]).toBe("\x04");
  });

  it("has no duplicate values that could cause ambiguity (except aliases)", () => {
    // return and enter are intentional aliases
    const entries = Object.entries(KEY_MAP).filter(([k]) => k !== "enter");
    const values = entries.map(([, v]) => v);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------
// Integration: start sidecar on OS-assigned port, exercise HTTP endpoints
// ---------------------------------------------------------------------------

describe("agent sidecar HTTP", () => {
  let handle: SidecarHandle | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  async function start(port: number): Promise<void> {
    const state = initialClientState();
    state.engineState = "idle";
    state.mode = "play";
    handle = await startAgentSidecar(port, () => state);
    baseUrl = `http://127.0.0.1:${port}`;
  }

  // Use a random high port to minimize collisions.
  const TEST_PORT = 19876;

  it("GET /screen returns 200 with text content", async () => {
    await start(TEST_PORT);
    const res = await fetch(`${baseUrl}/screen`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(typeof text).toBe("string");
  });

  it("GET /screen?ansi=true returns 200", async () => {
    await start(TEST_PORT);
    const res = await fetch(`${baseUrl}/screen?ansi=true`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(typeof text).toBe("string");
  });

  it("GET /state returns valid ClientState JSON", async () => {
    await start(TEST_PORT);
    const res = await fetch(`${baseUrl}/state`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("engineState", "idle");
    expect(data).toHaveProperty("mode", "play");
    expect(data).toHaveProperty("narrativeLines");
  });

  it("POST /input/key with known key returns 204", async () => {
    await start(TEST_PORT);
    const res = await fetch(`${baseUrl}/input/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "return" }),
    });
    expect(res.status).toBe(204);
  });

  it("POST /input/key with unknown key returns 400 with known list", async () => {
    await start(TEST_PORT);
    const res = await fetch(`${baseUrl}/input/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "bogus" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toHaveProperty("error");
    expect(data).toHaveProperty("known");
    expect(Array.isArray(data.known)).toBe(true);
  });

  it("POST /input/key with invalid JSON returns 400", async () => {
    await start(TEST_PORT);
    const res = await fetch(`${baseUrl}/input/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /input with raw body returns 204", async () => {
    await start(TEST_PORT);
    const res = await fetch(`${baseUrl}/input`, {
      method: "POST",
      body: "hello",
    });
    expect(res.status).toBe(204);
  });

  it("unknown route returns 404", async () => {
    await start(TEST_PORT);
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});
