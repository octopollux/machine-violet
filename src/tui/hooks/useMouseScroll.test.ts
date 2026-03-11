import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import {
  parseScrollEvents,
  stripMouseSequences,
  enableMouseReporting,
  disableMouseReporting,
  installMouseFilter,
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
});

// ---------------------------------------------------------------------------
// stripMouseSequences
// ---------------------------------------------------------------------------

describe("stripMouseSequences", () => {
  it("returns null when entire buffer is mouse sequences", () => {
    const buf = Buffer.from("\x1b[<64;10;20M\x1b[<0;5;5M");
    expect(stripMouseSequences(buf)).toBeNull();
  });

  it("returns original buffer when no mouse sequences present", () => {
    const buf = Buffer.from("hello world");
    expect(stripMouseSequences(buf)).toBe(buf); // reference-equal
  });

  it("strips mouse sequences and returns remainder", () => {
    const buf = Buffer.from("abc\x1b[<65;1;1Mdef");
    const result = stripMouseSequences(buf);
    expect(result).not.toBeNull();
    expect(result!.toString("utf8")).toBe("abcdef");
  });

  it("strips multiple mouse sequences from mixed content", () => {
    const buf = Buffer.from("\x1b[<0;1;1Mhello\x1b[<64;2;2M");
    const result = stripMouseSequences(buf);
    expect(result!.toString("utf8")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// installMouseFilter
// ---------------------------------------------------------------------------

describe("installMouseFilter", () => {
  it("calls onScroll for scroll events and suppresses emit", () => {
    const ee = new EventEmitter();
    const scrolls: number[] = [];
    const downstream = vi.fn();

    ee.on("data", downstream);
    const remove = installMouseFilter(ee, (d) => scrolls.push(d));

    ee.emit("data", Buffer.from("\x1b[<64;10;20M"));

    expect(scrolls).toEqual([-1]);
    expect(downstream).not.toHaveBeenCalled(); // fully consumed

    remove();
  });

  it("passes non-mouse data through to downstream listeners", () => {
    const ee = new EventEmitter();
    const downstream = vi.fn();

    ee.on("data", downstream);
    const remove = installMouseFilter(ee, () => {});

    ee.emit("data", Buffer.from("hello"));

    expect(downstream).toHaveBeenCalledTimes(1);
    expect(downstream.mock.calls[0][0].toString("utf8")).toBe("hello");

    remove();
  });

  it("strips mouse sequences from mixed data and passes remainder", () => {
    const ee = new EventEmitter();
    const scrolls: number[] = [];
    const downstream = vi.fn();

    ee.on("data", downstream);
    const remove = installMouseFilter(ee, (d) => scrolls.push(d));

    ee.emit("data", Buffer.from("key\x1b[<65;1;1Mpress"));

    expect(scrolls).toEqual([1]);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(downstream.mock.calls[0][0].toString("utf8")).toBe("keypress");

    remove();
  });

  it("does not interfere with non-data events", () => {
    const ee = new EventEmitter();
    const listener = vi.fn();

    ee.on("end", listener);
    const remove = installMouseFilter(ee, () => {});

    ee.emit("end");

    expect(listener).toHaveBeenCalledTimes(1);

    remove();
  });

  it("restores original emit on teardown", () => {
    const ee = new EventEmitter();
    const downstream = vi.fn();
    ee.on("data", downstream);

    const remove = installMouseFilter(ee, () => {});

    // While active, mouse sequences are stripped
    ee.emit("data", Buffer.from("\x1b[<64;1;1M"));
    expect(downstream).not.toHaveBeenCalled();

    remove();

    // After teardown, mouse sequences pass through unfiltered
    ee.emit("data", Buffer.from("\x1b[<64;1;1M"));
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("handles non-Buffer data events (passes through unchanged)", () => {
    const ee = new EventEmitter();
    const downstream = vi.fn();

    ee.on("data", downstream);
    const remove = installMouseFilter(ee, () => {});

    ee.emit("data", "string data");

    expect(downstream).toHaveBeenCalledTimes(1);
    expect(downstream.mock.calls[0][0]).toBe("string data");

    remove();
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
