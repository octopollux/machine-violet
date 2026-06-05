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

  // Bind port 0 so the OS assigns a free ephemeral port — avoids collisions
  // with other tests / processes under parallel execution. The actual port is
  // read back from the handle.
  async function start(): Promise<void> {
    const state = initialClientState();
    state.engineState = "idle";
    state.mode = "play";
    handle = await startAgentSidecar(0, () => state);
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }

  it("GET /screen returns 200 with text content", async () => {
    await start();
    const res = await fetch(`${baseUrl}/screen`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(typeof text).toBe("string");
  });

  it("GET /screen?ansi=true returns 200", async () => {
    await start();
    const res = await fetch(`${baseUrl}/screen?ansi=true`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(typeof text).toBe("string");
  });

  it("GET /state returns valid ClientState JSON", async () => {
    await start();
    const res = await fetch(`${baseUrl}/state`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("engineState", "idle");
    expect(data).toHaveProperty("mode", "play");
    expect(data).toHaveProperty("narrativeLines");
  });

  it("POST /input/key with known key returns 204", async () => {
    await start();
    const res = await fetch(`${baseUrl}/input/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "return" }),
    });
    expect(res.status).toBe(204);
  });

  it("POST /input/key with unknown key returns 400 with known list", async () => {
    await start();
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
    await start();
    const res = await fetch(`${baseUrl}/input/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /input with raw body returns 204", async () => {
    await start();
    const res = await fetch(`${baseUrl}/input`, {
      method: "POST",
      body: "hello",
    });
    expect(res.status).toBe(204);
  });

  it("unknown route returns 404", async () => {
    await start();
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Stdout tee regression: the sidecar must install a process.stdout.write
// wrapper so /screen returns rendered terminal content. We don't try to
// drive a real write through it here — vitest intercepts process.stdout
// in a way that bypasses our wrapper for test-emitted writes. Full
// coverage of the tee lives in the test-harness `boot-and-quit` probe,
// which spawns a real subprocess.
// ---------------------------------------------------------------------------

describe("agent sidecar stdout tee", () => {
  let handle: SidecarHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it("installs and restores the process.stdout.write wrapper", async () => {
    const originalWrite = process.stdout.write;
    handle = await startAgentSidecar(0, () => initialClientState());

    // After startAgentSidecar, process.stdout.write must be a different
    // function — that's our tee. If this assertion ever flips back to
    // equality, the tee got skipped and /screen will return blanks.
    expect(process.stdout.write).not.toBe(originalWrite);

    // Wrapped write still must satisfy the WriteStream.write contract —
    // exercised by Ink with both string and Buffer chunks.
    const ok1 = process.stdout.write("");
    const ok2 = process.stdout.write(Buffer.alloc(0));
    expect(typeof ok1).toBe("boolean");
    expect(typeof ok2).toBe("boolean");

    await handle.close();
    handle = undefined;

    // close() must restore the original write to avoid leaking the tee
    // across tests / subsequent renders.
    expect(process.stdout.write).toBe(originalWrite);
  });
});
