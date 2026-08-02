import { registerPainter, compositePainters, painterCount, clearPainters } from "./painterRegistry.js";
import type { FrameDamage } from "./frameDamage.js";

describe("painterRegistry", () => {
  beforeEach(() => clearPainters());

  it("composites registered painters in insertion order, skipping empties", () => {
    registerPainter("a", () => "AAA");
    registerPainter("b", () => "");
    registerPainter("c", () => "CCC");
    expect(compositePainters()).toBe("AAACCC");
  });

  it("returns empty string when nothing registered", () => {
    expect(compositePainters()).toBe("");
  });

  it("unregister removes only that painter", () => {
    const off = registerPainter("a", () => "AAA");
    registerPainter("b", () => "BBB");
    off();
    expect(compositePainters()).toBe("BBB");
    expect(painterCount()).toBe(1);
  });

  it("re-registering a key replaces the painter", () => {
    registerPainter("a", () => "OLD");
    registerPainter("a", () => "NEW");
    expect(compositePainters()).toBe("NEW");
    expect(painterCount()).toBe(1);
  });

  it("a stale unregister does not delete a replaced painter", () => {
    const off = registerPainter("a", () => "OLD");
    registerPainter("a", () => "NEW"); // replaces "a"
    off(); // stale handle — must NOT remove the new painter
    expect(compositePainters()).toBe("NEW");
    expect(painterCount()).toBe(1);
  });

  it("analyzes the frame block once and hands the damage report to painters", () => {
    const seen: FrameDamage[] = [];
    registerPainter("a", (d) => { seen.push(d); return ""; });
    compositePainters("\x1b[?2026h\x1b[2J\x1b[?2026l"); // clear-frame block
    compositePainters();                                  // no block (teardown/test path)
    expect(seen[0].full).toBe(true);
    expect(seen[1].full).toBe(false);
  });

  it("reads painters live (reflects ref changes)", () => {
    let frame = "";
    registerPainter("img", () => frame);
    expect(compositePainters()).toBe("");
    frame = "\x1bPq...sixel...\x1b\\";
    expect(compositePainters()).toBe("\x1bPq...sixel...\x1b\\");
  });
});
