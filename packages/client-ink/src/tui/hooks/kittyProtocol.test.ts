import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseKittyKey,
  kittyKeyToLegacy,
  extractKittyKeys,
  splitTrailingPartial,
  detectKittySupport,
  enableKittyProtocol,
  disableKittyProtocol,
  createKittyFilter,
  type KittyKey,
} from "./kittyProtocol.js";

const flushNextTick = () => new Promise((r) => process.nextTick(r));

// ---------------------------------------------------------------------------
// parseKittyKey
// ---------------------------------------------------------------------------

describe("parseKittyKey", () => {
  it("parses unmodified backspace", () => {
    const k = parseKittyKey(127, 1);
    expect(k).toEqual({ key: "backspace", code: 127, shift: false, ctrl: false, alt: false });
  });

  it("parses unmodified enter", () => {
    const k = parseKittyKey(13, 1);
    expect(k).toEqual({ key: "enter", code: 13, shift: false, ctrl: false, alt: false });
  });

  it("parses unmodified tab", () => {
    const k = parseKittyKey(9, 1);
    expect(k).toEqual({ key: "tab", code: 9, shift: false, ctrl: false, alt: false });
  });

  it("parses unmodified escape", () => {
    const k = parseKittyKey(27, 1);
    expect(k).toEqual({ key: "escape", code: 27, shift: false, ctrl: false, alt: false });
  });

  it("parses Ctrl+C (modifiers=5 → ctrl)", () => {
    // modifiers = 1 + 4 (ctrl) = 5
    const k = parseKittyKey(99, 5);
    expect(k).toEqual({ key: "c", code: 99, shift: false, ctrl: true, alt: false });
  });

  it("parses Shift+Tab (modifiers=2 → shift)", () => {
    const k = parseKittyKey(9, 2);
    expect(k).toEqual({ key: "tab", code: 9, shift: true, ctrl: false, alt: false });
  });

  it("parses Alt+A (modifiers=3 → alt)", () => {
    // modifiers = 1 + 2 (alt) = 3
    const k = parseKittyKey(97, 3);
    expect(k).toEqual({ key: "a", code: 97, shift: false, ctrl: false, alt: true });
  });

  it("parses Ctrl+Shift+Alt (modifiers=8 → all three)", () => {
    // 1 + 1(shift) + 2(alt) + 4(ctrl) = 8
    const k = parseKittyKey(97, 8);
    expect(k).toEqual({ key: "a", code: 97, shift: true, ctrl: true, alt: true });
  });

  it("parses home key", () => {
    const k = parseKittyKey(57356, 1);
    expect(k).toEqual({ key: "home", code: 57356, shift: false, ctrl: false, alt: false });
  });

  it("parses end key", () => {
    const k = parseKittyKey(57357, 1);
    expect(k).toEqual({ key: "end", code: 57357, shift: false, ctrl: false, alt: false });
  });

  it("parses arrow keys", () => {
    expect(parseKittyKey(57350, 1)?.key).toBe("left");
    expect(parseKittyKey(57351, 1)?.key).toBe("right");
    expect(parseKittyKey(57352, 1)?.key).toBe("up");
    expect(parseKittyKey(57353, 1)?.key).toBe("down");
  });

  it("parses printable character", () => {
    const k = parseKittyKey(0x61, 1); // 'a'
    expect(k).toEqual({ key: "a", code: 0x61, shift: false, ctrl: false, alt: false });
  });

  it("returns null for modifier-only keys (Caps Lock)", () => {
    expect(parseKittyKey(57358, 1)).toBeNull();
  });

  it("returns null for modifier-only keys (Scroll Lock)", () => {
    expect(parseKittyKey(57359, 1)).toBeNull();
  });

  it("returns null for modifier-only keys (Num Lock)", () => {
    expect(parseKittyKey(57360, 1)).toBeNull();
  });

  it("returns null for modifier-only keys (Left Shift)", () => {
    expect(parseKittyKey(57441, 1)).toBeNull();
  });

  it("returns null for modifier-only keys (Right Ctrl)", () => {
    expect(parseKittyKey(57448, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kittyKeyToLegacy
// ---------------------------------------------------------------------------

describe("kittyKeyToLegacy", () => {
  it("converts backspace to \\x7f", () => {
    const k: KittyKey = { key: "backspace", code: 127, shift: false, ctrl: false, alt: false };
    expect(kittyKeyToLegacy(k)).toBe("\x7f");
  });

  it("converts enter to \\r", () => {
    const k: KittyKey = { key: "enter", code: 13, shift: false, ctrl: false, alt: false };
    expect(kittyKeyToLegacy(k)).toBe("\r");
  });

  it("converts tab to \\t", () => {
    const k: KittyKey = { key: "tab", code: 9, shift: false, ctrl: false, alt: false };
    expect(kittyKeyToLegacy(k)).toBe("\t");
  });

  it("converts escape to \\x1b", () => {
    const k: KittyKey = { key: "escape", code: 27, shift: false, ctrl: false, alt: false };
    expect(kittyKeyToLegacy(k)).toBe("\x1b");
  });

  it("converts arrows to legacy sequences", () => {
    expect(kittyKeyToLegacy({ key: "up", code: 57352, shift: false, ctrl: false, alt: false })).toBe("\x1b[A");
    expect(kittyKeyToLegacy({ key: "down", code: 57353, shift: false, ctrl: false, alt: false })).toBe("\x1b[B");
    expect(kittyKeyToLegacy({ key: "right", code: 57351, shift: false, ctrl: false, alt: false })).toBe("\x1b[C");
    expect(kittyKeyToLegacy({ key: "left", code: 57350, shift: false, ctrl: false, alt: false })).toBe("\x1b[D");
  });

  it("converts home/end to legacy sequences", () => {
    expect(kittyKeyToLegacy({ key: "home", code: 57356, shift: false, ctrl: false, alt: false })).toBe("\x1b[H");
    expect(kittyKeyToLegacy({ key: "end", code: 57357, shift: false, ctrl: false, alt: false })).toBe("\x1b[F");
  });

  it("passes through plain printable characters", () => {
    const k: KittyKey = { key: "a", code: 0x61, shift: false, ctrl: false, alt: false };
    expect(kittyKeyToLegacy(k)).toBe("a");
  });

  it("converts Ctrl+C to \\x03", () => {
    const k: KittyKey = { key: "c", code: 99, shift: false, ctrl: true, alt: false };
    expect(kittyKeyToLegacy(k)).toBe("\x03");
  });

  it("converts Ctrl+A to \\x01", () => {
    const k: KittyKey = { key: "a", code: 97, shift: false, ctrl: true, alt: false };
    expect(kittyKeyToLegacy(k)).toBe("\x01");
  });

  it("converts Alt+a to ESC a", () => {
    const k: KittyKey = { key: "a", code: 97, shift: false, ctrl: false, alt: true };
    expect(kittyKeyToLegacy(k)).toBe("\x1ba");
  });
});

// ---------------------------------------------------------------------------
// extractKittyKeys
// ---------------------------------------------------------------------------

describe("extractKittyKeys", () => {
  it("extracts a single CSI-u backspace", () => {
    const { keys, remainder } = extractKittyKeys("\x1b[127u");
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("backspace");
    expect(remainder).toBeNull();
  });

  it("extracts CSI-u with modifiers", () => {
    // Ctrl+C: keycode 99, modifiers 5
    const { keys, remainder } = extractKittyKeys("\x1b[99;5u");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual({ key: "c", code: 99, shift: false, ctrl: true, alt: false });
    expect(remainder).toBeNull();
  });

  it("extracts multiple keys from mixed chunk", () => {
    const { keys, remainder } = extractKittyKeys("\x1b[127uhello\x1b[13u");
    expect(keys).toHaveLength(2);
    expect(keys[0].key).toBe("backspace");
    expect(keys[1].key).toBe("enter");
    expect(remainder).toBe("hello");
  });

  it("returns original string when no CSI-u sequences present", () => {
    const input = "hello world";
    const { keys, remainder } = extractKittyKeys(input);
    expect(keys).toHaveLength(0);
    expect(remainder).toBe(input); // same ref
  });

  it("drops modifier-only keys", () => {
    // Caps Lock = 57358
    const { keys, remainder } = extractKittyKeys("\x1b[57358u");
    expect(keys).toHaveLength(0);
    expect(remainder).toBeNull();
  });

  it("handles CSI-u with shifted sub-field", () => {
    // a with shifted A: CSI 97:65;2 u
    const { keys } = extractKittyKeys("\x1b[97:65;2u");
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("a");
    expect(keys[0].shift).toBe(true);
  });

  it("handles CSI-u with text codepoints sub-field", () => {
    // CSI 97;1;97 u (with text field)
    const { keys } = extractKittyKeys("\x1b[97;1;97u");
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// splitTrailingPartial
// ---------------------------------------------------------------------------

describe("splitTrailingPartial", () => {
  it("holds a bare trailing ESC", () => {
    expect(splitTrailingPartial("abc\x1b")).toEqual({ head: "abc", pending: "\x1b" });
  });

  it("holds a trailing ESC[", () => {
    expect(splitTrailingPartial("\x1b[")).toEqual({ head: "", pending: "\x1b[" });
  });

  it("holds a trailing ESC[<params> with no final byte", () => {
    expect(splitTrailingPartial("\x1b[13")).toEqual({ head: "", pending: "\x1b[13" });
    expect(splitTrailingPartial("x\x1b[57350")).toEqual({ head: "x", pending: "\x1b[57350" });
    expect(splitTrailingPartial("\x1b[13;5")).toEqual({ head: "", pending: "\x1b[13;5" });
    expect(splitTrailingPartial("\x1b[97:65;2")).toEqual({ head: "", pending: "\x1b[97:65;2" });
  });

  it("does NOT hold a complete CSI-u sequence", () => {
    expect(splitTrailingPartial("\x1b[13u")).toEqual({ head: "\x1b[13u", pending: "" });
  });

  it("does NOT hold a sequence terminated by a non-'u' final byte", () => {
    // Legacy arrow / function-key forms end in a letter or ~ — already complete.
    expect(splitTrailingPartial("\x1b[A")).toEqual({ head: "\x1b[A", pending: "" });
    expect(splitTrailingPartial("\x1b[3~")).toEqual({ head: "\x1b[3~", pending: "" });
  });

  it("does NOT hold a DA-style response (contains '?')", () => {
    expect(splitTrailingPartial("\x1b[?1u")).toEqual({ head: "\x1b[?1u", pending: "" });
  });

  it("holds only the trailing fragment when a complete sequence precedes it", () => {
    expect(splitTrailingPartial("\x1b[97u\x1b[13")).toEqual({
      head: "\x1b[97u",
      pending: "\x1b[13",
    });
  });

  it("returns plain text untouched", () => {
    expect(splitTrailingPartial("hello")).toEqual({ head: "hello", pending: "" });
    expect(splitTrailingPartial("")).toEqual({ head: "", pending: "" });
  });

  it("does NOT hold an over-long fragment (not a real keystroke)", () => {
    const long = "\x1b[" + "1".repeat(40);
    expect(splitTrailingPartial(long)).toEqual({ head: long, pending: "" });
  });
});

// ---------------------------------------------------------------------------
// detectKittySupport
// ---------------------------------------------------------------------------

describe("detectKittySupport", () => {
  it("returns true when terminal responds with CSI ? flags u", async () => {
    const { EventEmitter } = await import("node:events");
    const stdout = { write: vi.fn(() => true) };
    // Mock a readable stream that returns data on read() after 'readable'
    const responseData = Buffer.from("\x1b[?1u");
    let consumed = false;
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true as const,
      isRaw: true,
      read: () => {
        if (consumed) return null;
        consumed = true;
        return responseData;
      },
    }) as unknown as NodeJS.ReadStream;

    const promise = detectKittySupport({ stdin, stdout, timeoutMs: 50 });

    // Simulate terminal responding via readable event
    stdin.emit("readable");

    const result = await promise;
    expect(result).toBe(true);
    expect(stdout.write).toHaveBeenCalledWith("\x1b[?u");
  });

  it("returns false on timeout", async () => {
    const { EventEmitter } = await import("node:events");
    const stdout = { write: vi.fn(() => true) };
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true as const,
      isRaw: true,
      read: () => null,
    }) as unknown as NodeJS.ReadStream;

    const result = await detectKittySupport({ stdin, stdout, timeoutMs: 10 });
    expect(result).toBe(false);
  });

  it("handles response split across multiple readable events", async () => {
    const { EventEmitter } = await import("node:events");
    const stdout = { write: vi.fn(() => true) };
    const chunks = [Buffer.from("\x1b[?"), Buffer.from("1u")];
    let idx = 0;
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true as const,
      isRaw: true,
      read: () => {
        if (idx >= chunks.length) return null;
        return chunks[idx++];
      },
    }) as unknown as NodeJS.ReadStream;

    const promise = detectKittySupport({ stdin, stdout, timeoutMs: 50 });

    // First chunk — partial response
    stdin.emit("readable");
    // Second chunk — completes the response
    stdin.emit("readable");

    const result = await promise;
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enableKittyProtocol / disableKittyProtocol
// ---------------------------------------------------------------------------

describe("enableKittyProtocol / disableKittyProtocol", () => {
  // Clean up exit handlers between tests
  let exitListeners: ((...args: unknown[]) => void)[];

  beforeEach(() => {
    exitListeners = process.listeners("exit") as ((...args: unknown[]) => void)[];
  });

  it("writes push sequence on enable", () => {
    const stdout = { write: vi.fn(() => true) };
    enableKittyProtocol(stdout);
    expect(stdout.write).toHaveBeenCalledWith("\x1b[>1u");
    // Clean up
    disableKittyProtocol(stdout);
  });

  it("writes pop sequence on disable", () => {
    const stdout = { write: vi.fn(() => true) };
    enableKittyProtocol(stdout);
    stdout.write.mockClear();

    disableKittyProtocol(stdout);
    expect(stdout.write).toHaveBeenCalledWith("\x1b[<u");
  });

  it("registers exit handler on enable and removes on disable", () => {
    const stdout = { write: vi.fn(() => true) };
    enableKittyProtocol(stdout);

    const newListeners = process.listeners("exit") as ((...args: unknown[]) => void)[];
    expect(newListeners.length).toBeGreaterThan(exitListeners.length);

    disableKittyProtocol(stdout);
    const afterDisable = process.listeners("exit") as ((...args: unknown[]) => void)[];
    expect(afterDisable.length).toBe(exitListeners.length);
  });
});

// ---------------------------------------------------------------------------
// createKittyFilter
// ---------------------------------------------------------------------------

describe("createKittyFilter", () => {
  it("strips CSI-u sequences and dispatches keys via nextTick", async () => {
    const keys: KittyKey[] = [];
    const filter = createKittyFilter((k) => keys.push(k));

    const result = filter.process("\x1b[127uhello");
    expect(result).toBe("hello");
    expect(keys).toHaveLength(0); // deferred

    // Flush nextTick
    await new Promise((r) => process.nextTick(r));
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("backspace");
  });

  it("returns null when chunk is entirely CSI-u", () => {
    const filter = createKittyFilter(() => {});
    expect(filter.process("\x1b[127u")).toBeNull();
  });

  it("passes through chunks with no CSI-u sequences", () => {
    const filter = createKittyFilter(() => {});
    const input = "hello";
    expect(filter.process(input)).toBe(input);
  });

  it("has name 'kitty'", () => {
    const filter = createKittyFilter(() => {});
    expect(filter.name).toBe("kitty");
  });

  // -------------------------------------------------------------------------
  // Fragmentation across reads — regression guard for the missed-Enter bug
  // (#436). ConPTY can split a CSI-u keystroke across stdin reads; the filter
  // must buffer the incomplete tail instead of leaking it downstream.
  // -------------------------------------------------------------------------

  it("recovers a CSI-u Enter fragmented across two reads (#436)", async () => {
    const keys: KittyKey[] = [];
    const filter = createKittyFilter((k) => keys.push(k));

    // First read carries only the unterminated prefix — held, nothing leaks.
    expect(filter.process("\x1b[13")).toBeNull();
    await flushNextTick();
    expect(keys).toHaveLength(0);

    // Second read completes it — Enter is dispatched, nothing leaks downstream.
    expect(filter.process("u")).toBeNull();
    await flushNextTick();
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("enter");
    expect(kittyKeyToLegacy(keys[0])).toBe("\r"); // the byte Ink needs
  });

  it("recovers a fragment split right after ESC", async () => {
    const keys: KittyKey[] = [];
    const filter = createKittyFilter((k) => keys.push(k));
    expect(filter.process("\x1b")).toBeNull();
    expect(filter.process("[13u")).toBeNull();
    await flushNextTick();
    expect(keys.map((k) => k.key)).toEqual(["enter"]);
  });

  it("recovers a fragment split three ways", async () => {
    const keys: KittyKey[] = [];
    const filter = createKittyFilter((k) => keys.push(k));
    filter.process("\x1b[1");
    filter.process("3");
    filter.process("u");
    await flushNextTick();
    expect(keys.map((k) => k.key)).toEqual(["enter"]);
  });

  it("passes leading text through while buffering a trailing fragment", async () => {
    const keys: KittyKey[] = [];
    const filter = createKittyFilter((k) => keys.push(k));
    expect(filter.process("hi\x1b[13")).toBe("hi");
    expect(filter.process("u")).toBeNull();
    await flushNextTick();
    expect(keys.map((k) => k.key)).toEqual(["enter"]);
  });

  it("dispatches a complete key and holds a trailing fragment in one chunk", async () => {
    const keys: KittyKey[] = [];
    const filter = createKittyFilter((k) => keys.push(k));
    // 'a' (97) is complete; the trailing Enter prefix is incomplete.
    filter.process("\x1b[97u\x1b[13");
    await flushNextTick();
    expect(keys.map((k) => k.key)).toEqual(["a"]);
    filter.process("u");
    await flushNextTick();
    expect(keys.map((k) => k.key)).toEqual(["a", "enter"]);
  });

  it("reassembles a fragmented bracketed-paste start without dispatching keys", async () => {
    const keys: KittyKey[] = [];
    const filter = createKittyFilter((k) => keys.push(k));
    expect(filter.process("\x1b[200")).toBeNull(); // held
    // Completing it yields no CSI-u key; the whole marker flows downstream.
    expect(filter.process("~hi\x1b[201~")).toBe("\x1b[200~hi\x1b[201~");
    await flushNextTick();
    expect(keys).toHaveLength(0);
  });
});
