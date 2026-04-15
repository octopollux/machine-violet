import { describe, it, expect } from "vitest";
import { encodeFrame, getPipePath } from "./ipc-client.js";
import { Opcode } from "./types.js";

describe("encodeFrame", () => {
  it("produces correct header and JSON body", () => {
    const payload = { v: 1, client_id: "123" };
    const buf = encodeFrame(Opcode.HANDSHAKE, payload);
    const json = JSON.stringify(payload);

    // Header: 8 bytes
    expect(buf.length).toBe(8 + Buffer.byteLength(json));

    // Opcode at offset 0 (LE)
    expect(buf.readUInt32LE(0)).toBe(Opcode.HANDSHAKE);

    // Length at offset 4 (LE)
    expect(buf.readUInt32LE(4)).toBe(Buffer.byteLength(json));

    // JSON body
    expect(buf.subarray(8).toString("utf-8")).toBe(json);
  });

  it("encodes FRAME opcode correctly", () => {
    const buf = encodeFrame(Opcode.FRAME, { cmd: "SET_ACTIVITY" });
    expect(buf.readUInt32LE(0)).toBe(Opcode.FRAME);
  });

  it("handles unicode payload correctly", () => {
    const payload = { text: "café \u2014 résumé" };
    const buf = encodeFrame(Opcode.FRAME, payload);
    const json = JSON.stringify(payload);
    expect(buf.readUInt32LE(4)).toBe(Buffer.byteLength(json, "utf-8"));
    expect(buf.subarray(8).toString("utf-8")).toBe(json);
  });
});

describe("getPipePath", () => {
  it("returns platform-specific paths", () => {
    const path = getPipePath(0);
    if (process.platform === "win32") {
      expect(path).toContain("discord-ipc-0");
      expect(path).toContain("pipe");
    } else {
      expect(path).toContain("discord-ipc-0");
    }
  });

  it("includes the index in the path", () => {
    const path5 = getPipePath(5);
    expect(path5).toContain("discord-ipc-5");
  });

  it("respects XDG_RUNTIME_DIR on non-Windows", () => {
    if (process.platform === "win32") return; // skip on Windows
    const original = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    try {
      const path = getPipePath(0);
      expect(path).toContain("/run/user/1000");
    } finally {
      if (original === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = original;
    }
  });
});
