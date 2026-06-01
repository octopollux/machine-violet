import {
  parseSixelFromDeviceAttributes,
  parseKittyGraphics,
  parseCellPixelSize,
  parseTextAreaPixelSize,
  deriveCellPixels,
  parseColorRegisters,
  detectIterm2FromEnv,
  pickProtocol,
  sixelPaletteSize,
  parseGraphicsCapabilities,
  applyTerminalQuirks,
  TERMINAL_QUIRKS,
  detectGraphicsCapabilities,
  type GraphicsCapabilities,
  type ProbeStdin,
} from "./capabilities.js";

describe("parseSixelFromDeviceAttributes", () => {
  it("detects sixel (attribute 4) in a DA reply", () => {
    expect(parseSixelFromDeviceAttributes("\x1b[?62;4;6;9;22c")).toBe(true);
  });
  it("is false when attribute 4 is absent", () => {
    expect(parseSixelFromDeviceAttributes("\x1b[?62;22c")).toBe(false);
  });
  it("does not match a substring like 41 or 14", () => {
    expect(parseSixelFromDeviceAttributes("\x1b[?41;14c")).toBe(false);
  });
  it("is false on garbage", () => {
    expect(parseSixelFromDeviceAttributes("nonsense")).toBe(false);
  });
});

describe("parseKittyGraphics", () => {
  it("detects the OK response", () => {
    expect(parseKittyGraphics("\x1b_Gi=31;OK\x1b\\")).toBe(true);
  });
  it("is false on an error response", () => {
    expect(parseKittyGraphics("\x1b_Gi=31;ENODATA:bad\x1b\\")).toBe(false);
  });
  it("is false when no kitty response present", () => {
    expect(parseKittyGraphics("\x1b[?62;4c")).toBe(false);
  });
});

describe("parseCellPixelSize", () => {
  it("parses a 16t reply (height;width)", () => {
    expect(parseCellPixelSize("\x1b[6;20;10t")).toEqual({ width: 10, height: 20 });
  });
  it("returns null for the 14t terminal-size reply", () => {
    expect(parseCellPixelSize("\x1b[4;1012;1419t")).toBeNull();
  });
  it("returns null on absent/garbled reply", () => {
    expect(parseCellPixelSize("")).toBeNull();
    expect(parseCellPixelSize("\x1b[6;0;0t")).toBeNull();
  });
});

describe("parseTextAreaPixelSize", () => {
  it("parses a 14t reply (height;width)", () => {
    expect(parseTextAreaPixelSize("\x1b[4;480;700t")).toEqual({ width: 700, height: 480 });
  });
  it("returns null for the 16t cell-size reply and garbage", () => {
    expect(parseTextAreaPixelSize("\x1b[6;20;10t")).toBeNull();
    expect(parseTextAreaPixelSize("")).toBeNull();
  });
});

describe("deriveCellPixels", () => {
  it("divides text-area pixels by char dimensions", () => {
    expect(deriveCellPixels({ width: 700, height: 480 }, 100, 30)).toEqual({ width: 7, height: 16 });
  });
  it("returns null on missing text area or degenerate dimensions", () => {
    expect(deriveCellPixels(null, 100, 30)).toBeNull();
    expect(deriveCellPixels({ width: 700, height: 480 }, 0, 30)).toBeNull();
  });
});

describe("detectIterm2FromEnv", () => {
  it("true for iTerm.app", () => {
    expect(detectIterm2FromEnv({ TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("true for recent WezTerm, false for old", () => {
    expect(detectIterm2FromEnv({ TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20230101-120000-abc" } as NodeJS.ProcessEnv)).toBe(true);
    expect(detectIterm2FromEnv({ TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20200101-120000-abc" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("false for plain xterm / Windows Terminal", () => {
    expect(detectIterm2FromEnv({ TERM_PROGRAM: "WindowsTerminal" } as NodeJS.ProcessEnv)).toBe(false);
    expect(detectIterm2FromEnv({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("parseColorRegisters", () => {
  it("parses an XTSMGRAPHICS success reply", () => {
    expect(parseColorRegisters("\x1b[?1;0;1024S")).toBe(1024);
  });
  it("returns null on an error status (Ps != 0)", () => {
    expect(parseColorRegisters("\x1b[?1;1;0S")).toBeNull();
  });
  it("returns null on absent reply", () => {
    expect(parseColorRegisters("\x1b[?62;4c")).toBeNull();
  });
});

describe("pickProtocol", () => {
  const base: GraphicsCapabilities = { kitty: false, iterm2: false, sixel: false, cellPixels: null, sixelColorRegisters: null };
  it("prefers kitty > iterm2 > sixel", () => {
    expect(pickProtocol({ ...base, kitty: true, iterm2: true, sixel: true, sixelColorRegisters: 1024 })).toBe("kitty");
    expect(pickProtocol({ ...base, iterm2: true, sixel: true, sixelColorRegisters: 1024 })).toBe("iterm2");
    expect(pickProtocol({ ...base, sixel: true, sixelColorRegisters: 1024 })).toBe("sixel");
  });
  it("allows sixel when register count is unreported (assumes 256 floor)", () => {
    expect(pickProtocol({ ...base, sixel: true, sixelColorRegisters: null })).toBe("sixel");
    expect(pickProtocol({ ...base, sixel: true, sixelColorRegisters: 256 })).toBe("sixel");
  });
  it("disables sixel when the terminal reports < 256 registers", () => {
    expect(pickProtocol({ ...base, sixel: true, sixelColorRegisters: 16 })).toBeNull();
  });
  it("returns null when none supported", () => {
    expect(pickProtocol(base)).toBeNull();
  });
});

describe("sixelPaletteSize", () => {
  const base: GraphicsCapabilities = { kitty: false, iterm2: false, sixel: true, cellPixels: null, sixelColorRegisters: null };
  it("defaults to 256 when unreported", () => {
    expect(sixelPaletteSize(base)).toBe(256);
  });
  it("uses the reported count up to the 1024 cap", () => {
    expect(sixelPaletteSize({ ...base, sixelColorRegisters: 512 })).toBe(512);
    expect(sixelPaletteSize({ ...base, sixelColorRegisters: 65536 })).toBe(1024);
  });
  it("floors at 256", () => {
    expect(sixelPaletteSize({ ...base, sixelColorRegisters: 64 })).toBe(256);
  });
});

describe("parseGraphicsCapabilities", () => {
  const REPLY =
    "\x1b_Gi=31;OK\x1b\\" + "\x1b[6;20;10t" + "\x1b[?1;0;1024S" + "\x1b[?62;4c";

  it("assembles raw caps from the probe buffer + env", () => {
    const caps = parseGraphicsCapabilities(REPLY, {} as NodeJS.ProcessEnv, 100, 30);
    expect(caps).toEqual({
      kitty: true,
      iterm2: false,
      sixel: true,
      cellPixels: { width: 10, height: 20 },
      sixelColorRegisters: 1024,
    });
  });

  it("reports only env-sniffed caps for an empty buffer (non-TTY/timeout)", () => {
    const caps = parseGraphicsCapabilities("", { TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv, 100, 30);
    expect(caps).toEqual({ kitty: false, iterm2: true, sixel: false, cellPixels: null, sixelColorRegisters: null });
  });
});

describe("terminal quirks", () => {
  const rawKitty: GraphicsCapabilities = { kitty: true, iterm2: true, sixel: false, cellPixels: null, sixelColorRegisters: null };

  it("every quirk documents a name and reason (the only record of why)", () => {
    for (const q of TERMINAL_QUIRKS) {
      expect(q.name.length).toBeGreaterThan(0);
      expect(q.reason.length).toBeGreaterThan(0);
    }
  });

  it("disables kitty on iTerm.app (its kitty impl is broken) without mutating input", () => {
    const env = { TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv;
    const out = applyTerminalQuirks(rawKitty, env);
    expect(out.kitty).toBe(false);
    expect(out.iterm2).toBe(true);
    expect(rawKitty.kitty).toBe(true); // input untouched
  });

  it("leaves capabilities untouched for terminals with no matching quirk", () => {
    const env = { TERM_PROGRAM: "WezTerm" } as NodeJS.ProcessEnv;
    expect(applyTerminalQuirks(rawKitty, env)).toEqual(rawKitty);
  });
});

describe("detectGraphicsCapabilities", () => {
  // A terminal reply carrying: kitty OK, cell size, max registers, sixel DA.
  const REPLY =
    "\x1b_Gi=31;OK\x1b\\" + // kitty graphics OK
    "\x1b[6;20;10t" + // cell size 10x20
    "\x1b[?1;0;1024S" + // 1024 color registers
    "\x1b[?62;4c"; // DA with sixel (attribute 4) — terminator

  /** Minimal ProbeStdin that delivers REPLY once after the queries are sent. */
  function mockStdin(reply: string): ProbeStdin {
    let pending: string | null = reply;
    return {
      isTTY: true,
      on(_event, listener) {
        // Fire after the synchronous probe body (queries) completes.
        queueMicrotask(() => listener());
      },
      removeListener() {},
      read() {
        const out = pending;
        pending = null;
        return out;
      },
    };
  }
  const sink = { write: () => true };

  it("detects kitty on a kitty-capable terminal", async () => {
    const caps = await detectGraphicsCapabilities(mockStdin(REPLY), sink, {} as NodeJS.ProcessEnv);
    expect(caps.kitty).toBe(true);
    expect(caps.sixel).toBe(true);
    expect(caps.cellPixels).toEqual({ width: 10, height: 20 });
    expect(caps.sixelColorRegisters).toBe(1024);
  });

  it("suppresses kitty on iTerm.app even when it answers the kitty query", async () => {
    const env = { TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv;
    const caps = await detectGraphicsCapabilities(mockStdin(REPLY), sink, env);
    expect(caps.kitty).toBe(false); // forced off → use native iTerm2 protocol
    expect(caps.iterm2).toBe(true);
    expect(pickProtocol(caps)).toBe("iterm2");
  });

  it("keeps the 16t cell size when present, ignoring 14t (no change for existing terminals)", async () => {
    // Both replies present: 16t says 10x20, 14t says 700x480 — 16t must win.
    const reply = "\x1b[6;20;10t" + "\x1b[4;480;700t" + "\x1b[?62;4c";
    const caps = await detectGraphicsCapabilities(mockStdin(reply), sink, {} as NodeJS.ProcessEnv, 250, 100, 30);
    expect(caps.cellPixels).toEqual({ width: 10, height: 20 });
  });

  it("falls back to 14t-derived cell size only when 16t is absent (iTerm2)", async () => {
    // No 16t; 14t text area 700x480 over a 100x30 grid → 7x16 cells.
    const reply = "\x1b[4;480;700t" + "\x1b[?62;4c";
    const caps = await detectGraphicsCapabilities(mockStdin(reply), sink, {} as NodeJS.ProcessEnv, 250, 100, 30);
    expect(caps.cellPixels).toEqual({ width: 7, height: 16 });
  });
});
