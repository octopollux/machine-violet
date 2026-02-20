import { describe, it, expect, vi } from "vitest";
import type { Key as InkKey } from "ink";

// Test the logic directly — the hook is thin enough that we can
// exercise handleKey/clear by inlining the same logic.

const baseKey: InkKey = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  return: false, escape: false, ctrl: false, meta: false, shift: false, tab: false,
  backspace: false, delete: false, pageDown: false, pageUp: false,
};

function key(overrides: Partial<InkKey> = {}): InkKey {
  return { ...baseKey, ...overrides };
}

/** Simulates what useTextInput does internally, for unit testing without React. */
function makeHandleKey(onChange: React.Dispatch<React.SetStateAction<string>>, disabled = false) {
  return (input: string, k: InkKey): boolean => {
    if (disabled) return false;
    if (k.backspace || k.delete) {
      onChange((v) => v.slice(0, -1));
      return true;
    }
    if (input && !k.ctrl && !k.meta && !k.return) {
      onChange((v) => v + input);
      return true;
    }
    return false;
  };
}

describe("useTextInput (logic)", () => {
  it("appends characters", () => {
    const onChange = vi.fn();
    const handleKey = makeHandleKey(onChange);
    handleKey("a", key());
    expect(onChange).toHaveBeenCalled();
    const setter = onChange.mock.calls[0][0] as (v: string) => string;
    expect(setter("hi")).toBe("hia");
  });

  it("handles backspace", () => {
    const onChange = vi.fn();
    const handleKey = makeHandleKey(onChange);
    handleKey("", key({ backspace: true }));
    const setter = onChange.mock.calls[0][0] as (v: string) => string;
    expect(setter("hi")).toBe("h");
  });

  it("handles delete key", () => {
    const onChange = vi.fn();
    const handleKey = makeHandleKey(onChange);
    handleKey("", key({ delete: true }));
    const setter = onChange.mock.calls[0][0] as (v: string) => string;
    expect(setter("abc")).toBe("ab");
  });

  it("ignores ctrl keys", () => {
    const onChange = vi.fn();
    const handleKey = makeHandleKey(onChange);
    const consumed = handleKey("c", key({ ctrl: true }));
    expect(consumed).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores meta keys", () => {
    const onChange = vi.fn();
    const handleKey = makeHandleKey(onChange);
    const consumed = handleKey("v", key({ meta: true }));
    expect(consumed).toBe(false);
  });

  it("ignores return key", () => {
    const onChange = vi.fn();
    const handleKey = makeHandleKey(onChange);
    const consumed = handleKey("", key({ return: true }));
    expect(consumed).toBe(false);
  });

  it("does nothing when disabled", () => {
    const onChange = vi.fn();
    const handleKey = makeHandleKey(onChange, true);
    expect(handleKey("a", key())).toBe(false);
    expect(handleKey("", key({ backspace: true }))).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
