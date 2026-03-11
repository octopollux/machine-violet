import { describe, it, expect } from "vitest";
import {
  parseScrollEvents,
  enableMouseReporting,
  disableMouseReporting,
} from "./useMouseScroll.js";

// ---------------------------------------------------------------------------
// parseScrollEvents
// ---------------------------------------------------------------------------

describe("parseScrollEvents", () => {
  it("detects scroll-up (btn=64 → bit0=0 → up)", () => {
    // SGR sequence: \x1b[<64;10;20M
    const buf = Buffer.from("\x1b[<64;10;20M");
    expect(parseScrollEvents(buf)).toEqual([-1]);
  });

  it("detects scroll-down (btn=65 → bit0=1 → down)", () => {
    const buf = Buffer.from("\x1b[<65;10;20M");
    expect(parseScrollEvents(buf)).toEqual([1]);
  });

  it("returns multiple scroll events from one buffer", () => {
    const buf = Buffer.from("\x1b[<64;5;5M\x1b[<65;5;5M\x1b[<64;5;5M");
    expect(parseScrollEvents(buf)).toEqual([-1, 1, -1]);
  });

  it("ignores non-scroll mouse events (btn < 64)", () => {
    // btn=0 → left click
    const buf = Buffer.from("\x1b[<0;10;20M");
    expect(parseScrollEvents(buf)).toEqual([]);
  });

  it("ignores release events for non-scroll buttons", () => {
    // btn=0 release (lowercase m)
    const buf = Buffer.from("\x1b[<0;10;20m");
    expect(parseScrollEvents(buf)).toEqual([]);
  });

  it("handles scroll with modifier keys (shift=4, meta=8, ctrl=16)", () => {
    // btn = 64 + 4 (shift) = 68 → still scroll up (bit0=0)
    const buf = Buffer.from("\x1b[<68;10;20M");
    expect(parseScrollEvents(buf)).toEqual([-1]);
  });

  it("returns empty array for non-mouse data", () => {
    const buf = Buffer.from("hello world");
    expect(parseScrollEvents(buf)).toEqual([]);
  });

  it("returns empty array for empty buffer", () => {
    expect(parseScrollEvents(Buffer.alloc(0))).toEqual([]);
  });

  it("handles mixed mouse and non-mouse data", () => {
    const buf = Buffer.from("text\x1b[<65;1;1Mmore text");
    expect(parseScrollEvents(buf)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// enableMouseReporting / disableMouseReporting
// ---------------------------------------------------------------------------

describe("enableMouseReporting", () => {
  it("writes enable sequences", () => {
    const written: string[] = [];
    const output = { write: (s: string) => { written.push(s); return true; } };
    enableMouseReporting(output);
    expect(written).toContain("\x1b[?1000h");
    expect(written).toContain("\x1b[?1006h");
  });
});

describe("disableMouseReporting", () => {
  it("writes disable sequences", () => {
    const written: string[] = [];
    const output = { write: (s: string) => { written.push(s); return true; } };
    disableMouseReporting(output);
    expect(written).toContain("\x1b[?1000l");
    expect(written).toContain("\x1b[?1006l");
  });
});
