import { describe, it, expect, vi } from "vitest";
import {
  parseScrollEvents,
  stripMouseSequences,
  enableMouseReporting,
  disableMouseReporting,
  installMouseFilter,
} from "./useMouseScroll.js";
import type { ReadableStdin } from "./useMouseScroll.js";

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
// installMouseFilter
// ---------------------------------------------------------------------------

describe("installMouseFilter", () => {
  function makeFakeStdin(chunks: (string | null)[]): ReadableStdin {
    let i = 0;
    return {
      read(_size?: number) {
        if (i >= chunks.length) return null;
        return chunks[i++];
      },
    };
  }

  /** Flush process.nextTick queue so deferred onScroll calls execute. */
  function flushNextTick(): Promise<void> {
    return new Promise((resolve) => process.nextTick(resolve));
  }

  it("returns empty string for fully-consumed chunk and defers onScroll", async () => {
    const stdin = makeFakeStdin(["\x1b[<64;10;20M"]);
    const scrolls: number[] = [];

    const remove = installMouseFilter(stdin, (d) => scrolls.push(d));

    const result = stdin.read();
    expect(result).toBe(""); // fully consumed → empty string, not null
    expect(scrolls).toEqual([]); // not yet — deferred

    await flushNextTick();
    expect(scrolls).toEqual([-1]);

    remove();
  });

  it("passes non-mouse data through unchanged", () => {
    const stdin = makeFakeStdin(["hello"]);

    const remove = installMouseFilter(stdin, () => {});

    const result = stdin.read();
    expect(result).toBe("hello");

    remove();
  });

  it("strips mouse sequences from mixed data and passes remainder", async () => {
    const stdin = makeFakeStdin(["key\x1b[<65;1;1Mpress"]);
    const scrolls: number[] = [];

    const remove = installMouseFilter(stdin, (d) => scrolls.push(d));

    const result = stdin.read();
    expect(result).toBe("keypress");

    await flushNextTick();
    expect(scrolls).toEqual([1]);

    remove();
  });

  it("returns null when original read returns null", () => {
    const stdin = makeFakeStdin([null]);

    const remove = installMouseFilter(stdin, () => {});

    expect(stdin.read()).toBeNull();

    remove();
  });

  it("restores original read on teardown", async () => {
    const stdin = makeFakeStdin([
      "\x1b[<64;1;1M",  // consumed by filter
      "\x1b[<64;1;1M",  // after teardown, passes through
    ]);
    const scrolls: number[] = [];

    const remove = installMouseFilter(stdin, (d) => scrolls.push(d));

    stdin.read(); // filtered
    await flushNextTick();
    expect(scrolls).toEqual([-1]);

    remove();

    // After teardown, mouse sequences pass through as-is
    const result = stdin.read();
    expect(result).toBe("\x1b[<64;1;1M");
    expect(scrolls).toEqual([-1]); // no new scroll events
  });

  it("handles Buffer chunks and returns Buffer", async () => {
    const buf = Buffer.from("abc\x1b[<65;1;1Mdef");
    const stdin: ReadableStdin = {
      read: vi.fn().mockReturnValueOnce(buf),
    };
    const scrolls: number[] = [];

    const remove = installMouseFilter(stdin, (d) => scrolls.push(d));

    const result = stdin.read();
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).toString("utf8")).toBe("abcdef");

    await flushNextTick();
    expect(scrolls).toEqual([1]);

    remove();
  });

  it("returns empty Buffer for fully-consumed Buffer chunk", () => {
    const buf = Buffer.from("\x1b[<64;10;20M");
    const stdin: ReadableStdin = {
      read: vi.fn().mockReturnValueOnce(buf),
    };

    const remove = installMouseFilter(stdin, () => {});

    const result = stdin.read();
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).length).toBe(0);

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
