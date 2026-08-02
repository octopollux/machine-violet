import { analyzeFrameDamage, damageTouches, damagedAtRow, NO_DAMAGE } from "./frameDamage.js";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

describe("analyzeFrameDamage", () => {
  it("reports no damage for an empty repaint block (BSU+ESU only)", () => {
    const d = analyzeFrameDamage(BSU + ESU);
    expect(d.full).toBe(false);
    if (!d.full) expect(d.rowsAboveCursor.size).toBe(0);
  });

  it("reports no damage for row-neutral escapes (SGR, cursor hide/show, OSC)", () => {
    const d = analyzeFrameDamage(BSU + "\x1b[?25l\x1b[1;32m\x1b[0m\x1b]0;title\x07" + ESU);
    expect(d.full).toBe(false);
    if (!d.full) expect(d.rowsAboveCursor.size).toBe(0);
  });

  it("tracks a single-line rewrite in an incremental frame to its row", () => {
    // Ink incremental frame over a 20-line fullscreen app, only the LAST line
    // changed: up(19), 19× cursorNextLine (unchanged lines), then
    // cursorTo(0) + text + eraseEndLine — no trailing newline on the last line.
    const block =
      BSU + "\x1b[19A" + "\x1b[E".repeat(19) + "\x1b[1G" + "new last line" + "\x1b[K" + ESU;
    const d = analyzeFrameDamage(block);
    expect(d.full).toBe(false);
    if (d.full) return;
    // Cursor ends on the damaged row itself → distance 0 only.
    expect([...d.rowsAboveCursor]).toEqual([0]);
  });

  it("tracks a mid-frame line rewrite to its distance above the resting row", () => {
    // up(19), 7 unchanged lines, rewrite line 7 (with trailing \n), 12 more
    // unchanged lines — cursor rests on the last row (distance 12 above it... )
    const block =
      BSU +
      "\x1b[19A" +
      "\x1b[E".repeat(7) +
      "\x1b[1G" + "changed row seven" + "\x1b[K\n" +
      "\x1b[E".repeat(11) +
      ESU;
    const d = analyzeFrameDamage(block);
    expect(d.full).toBe(false);
    if (d.full) return;
    expect([...d.rowsAboveCursor]).toEqual([12]);
  });

  it("reports full damage for erase-in-display (clearTerminal / win32 frames)", () => {
    expect(analyzeFrameDamage(BSU + "\x1b[2J\x1b[0;0f" + "whole frame" + ESU).full).toBe(true);
  });

  it("reports full damage for absolute cursor jumps", () => {
    expect(analyzeFrameDamage(BSU + "\x1b[5;10H" + "text" + ESU).full).toBe(true);
  });

  it("reports full damage for unknown CSI finals and truncated sequences", () => {
    expect(analyzeFrameDamage(BSU + "\x1b[2M" + ESU).full).toBe(true); // delete lines
    expect(analyzeFrameDamage(BSU + "\x1b[12").full).toBe(true); // truncated
    expect(analyzeFrameDamage("\x1bPq#0;2;0;0;0#0~~\x1b\\").full).toBe(true); // DCS
  });

  it("reports full damage for alt-screen and unknown private modes", () => {
    expect(analyzeFrameDamage("\x1b[?1049h").full).toBe(true);
    expect(analyzeFrameDamage("\x1b[4h").full).toBe(true); // insert mode (non-private)
  });

  it("tracks eraseLines-style clears (log.clear) row by row", () => {
    // ansi-escapes eraseLines(3): 2K, up, 2K, up, 2K, col-0.
    const d = analyzeFrameDamage(BSU + "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1G" + ESU);
    expect(d.full).toBe(false);
    if (d.full) return;
    // Cursor ends 2 rows above start; damage at start row (2 below end), -1, 0.
    expect([...d.rowsAboveCursor].sort((a, b) => a - b)).toEqual([-2, -1, 0]);
  });

  it("honors save/restore cursor (DECSC/DECRC) for row tracking", () => {
    const d = analyzeFrameDamage("\x1b7\x1b[5Atext up five\x1b8");
    expect(d.full).toBe(false);
    if (d.full) return;
    // Damage 5 rows above where the cursor ended (restored to start).
    expect([...d.rowsAboveCursor]).toEqual([5]);
  });
});

describe("damagedAtRow", () => {
  it("is exact — no slop (gates the vacated-row erase)", () => {
    // Damage 12 above cursor row 19 → app row 7 only.
    const damage = { full: false as const, rowsAboveCursor: new Set([12]) };
    expect(damagedAtRow(damage, 7, 19)).toBe(true);
    expect(damagedAtRow(damage, 6, 19)).toBe(false);
    expect(damagedAtRow(damage, 8, 19)).toBe(false);
    expect(damagedAtRow({ full: true }, 3, 19)).toBe(true);
    expect(damagedAtRow(NO_DAMAGE, 3, 19)).toBe(false);
  });
});

describe("damageTouches", () => {
  it("always touches on full damage", () => {
    expect(damageTouches({ full: true }, 3, 4, 19)).toBe(true);
  });

  it("never touches on no damage", () => {
    expect(damageTouches(NO_DAMAGE, 3, 4, 19)).toBe(false);
  });

  it("touches when a damaged row falls inside the span", () => {
    // Damage 12 above cursor row 19 → app row 7; span [5, 10) includes 7.
    const damage = { full: false as const, rowsAboveCursor: new Set([12]) };
    expect(damageTouches(damage, 5, 5, 19)).toBe(true);
  });

  it("applies ±1 slop so adjacent-row damage still forces a repaint", () => {
    // Damage at app row 10; span [5, 10) excludes 10 but slop catches row 9's neighbor.
    const damage = { full: false as const, rowsAboveCursor: new Set([9]) };
    expect(damageTouches(damage, 5, 5, 19)).toBe(true);
    // Two rows clear of the span → no touch.
    const far = { full: false as const, rowsAboveCursor: new Set([7]) };
    expect(damageTouches(far, 5, 5, 19)).toBe(false);
  });
});
