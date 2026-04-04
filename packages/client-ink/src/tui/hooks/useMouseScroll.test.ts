import { describe, it, expect } from "vitest";
import {
  parseScrollEvents,
  stripMouseSequences,
  enableMouseReporting,
  disableMouseReporting,
  createMouseFilter,
} from "./useMouseScroll.js";

// ---------------------------------------------------------------------------
// parseScrollEvents
// ---------------------------------------------------------------------------

describe("parseScrollEvents", () => {
  it("detects scroll-up (btn=64 → bit0=0 → up)", () => {
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
    const buf = Buffer.from("\x1b[<0;10;20M");
    expect(parseScrollEvents(buf)).toEqual([]);
  });

  it("ignores release events for non-scroll buttons", () => {
    const buf = Buffer.from("\x1b[<0;10;20m");
    expect(parseScrollEvents(buf)).toEqual([]);
  });

  it("handles scroll with modifier keys (shift=4, meta=8, ctrl=16)", () => {
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

  it("accepts string input", () => {
    expect(parseScrollEvents("\x1b[<64;1;1M")).toEqual([-1]);
  });
});

// ---------------------------------------------------------------------------
// stripMouseSequences
// ---------------------------------------------------------------------------

describe("stripMouseSequences", () => {
  it("returns null when entire string is mouse sequences", () => {
    expect(stripMouseSequences("\x1b[<64;10;20M\x1b[<0;5;5M")).toBeNull();
  });

  it("returns original string when no mouse sequences present", () => {
    const str = "hello world";
    expect(stripMouseSequences(str)).toBe(str); // reference-equal
  });

  it("strips mouse sequences and returns remainder", () => {
    expect(stripMouseSequences("abc\x1b[<65;1;1Mdef")).toBe("abcdef");
  });

  it("strips multiple mouse sequences from mixed content", () => {
    expect(stripMouseSequences("\x1b[<0;1;1Mhello\x1b[<64;2;2M")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// createMouseFilter
// ---------------------------------------------------------------------------

describe("createMouseFilter", () => {
  /** Flush process.nextTick queue so deferred onScroll calls execute. */
  function flushNextTick(): Promise<void> {
    return new Promise((resolve) => process.nextTick(resolve));
  }

  it("returns null for fully-consumed chunk and defers onScroll", async () => {
    const scrolls: number[] = [];
    const filter = createMouseFilter((d) => scrolls.push(d));

    const result = filter.process("\x1b[<64;10;20M");
    expect(result).toBeNull(); // fully consumed
    expect(scrolls).toEqual([]); // deferred

    await flushNextTick();
    expect(scrolls).toEqual([-1]);
  });

  it("passes non-mouse data through unchanged", () => {
    const filter = createMouseFilter(() => {});
    const input = "hello";
    expect(filter.process(input)).toBe(input);
  });

  it("strips mouse sequences from mixed data and passes remainder", async () => {
    const scrolls: number[] = [];
    const filter = createMouseFilter((d) => scrolls.push(d));

    const result = filter.process("key\x1b[<65;1;1Mpress");
    expect(result).toBe("keypress");

    await flushNextTick();
    expect(scrolls).toEqual([1]);
  });

  it("has name 'mouse'", () => {
    const filter = createMouseFilter(() => {});
    expect(filter.name).toBe("mouse");
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
