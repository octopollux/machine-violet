import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseKittyKey,
  kittyKeyToLegacy,
  extractKittyKeys,
  detectKittySupport,
  enableKittyProtocol,
  disableKittyProtocol,
  installKittyFilter,
  type KittyKey,
} from "./kittyProtocol.js";

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
// installKittyFilter
// ---------------------------------------------------------------------------

describe("installKittyFilter", () => {
  it("strips CSI-u sequences and dispatches keys via nextTick", async () => {
    const keys: KittyKey[] = [];
    const input = {
      read: vi.fn(() => "\x1b[127uhello"),
    };

    const remove = installKittyFilter(input, (k) => keys.push(k));

    const result = input.read();
    expect(result).toBe("hello");
    expect(keys).toHaveLength(0); // deferred

    // Flush nextTick
    await new Promise((r) => process.nextTick(r));
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe("backspace");

    remove();
  });

  it("returns empty string when chunk is entirely CSI-u", () => {
    const input = {
      read: vi.fn(() => "\x1b[127u"),
    };

    const remove = installKittyFilter(input, () => {});
    const result = input.read();
    expect(result).toBe("");
    remove();
  });

  it("returns empty Buffer when chunk type is Buffer and fully consumed", () => {
    const input = {
      read: vi.fn(() => Buffer.from("\x1b[127u")),
    };

    const remove = installKittyFilter(input, () => {});
    const result = input.read();
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).length).toBe(0);
    remove();
  });

  it("passes through chunks with no CSI-u sequences", () => {
    const input = {
      read: vi.fn(() => "hello"),
    };

    const remove = installKittyFilter(input, () => {});
    const result = input.read();
    expect(result).toBe("hello");
    remove();
  });

  it("returns null when original read returns null", () => {
    const input = {
      read: vi.fn(() => null),
    };

    const remove = installKittyFilter(input, () => {});
    const result = input.read();
    expect(result).toBeNull();
    remove();
  });

  it("restores original read on teardown", () => {
    const originalRead = vi.fn(() => "test");
    const input = { read: originalRead };

    const remove = installKittyFilter(input, () => {});
    // Filter wraps read — the current function should differ
    const filteredRead = input.read;
    expect(filteredRead).not.toBe(originalRead);

    remove();
    // After teardown, calling read should hit the original mock
    input.read(undefined);
    expect(originalRead).toHaveBeenCalled();
  });
});
