import { composePaint, type PaintBox } from "./paint.js";

const SAVE = "\x1b7";
const RESTORE = "\x1b8";
const box = (row: number, rows: number): PaintBox => ({ row, col: 0, rows, cols: 10 });

describe("composePaint", () => {
  it("returns empty when nothing to show and nothing to erase", () => {
    expect(composePaint("", null, null, 30)).toBe("");
  });

  it("brackets the paint in save/restore and moves up appHeight-row", () => {
    const out = composePaint("<PAYLOAD>", box(5, 8), null, 30);
    expect(out.startsWith(SAVE)).toBe(true);
    expect(out.endsWith(RESTORE)).toBe(true);
    expect(out).toContain("\x1b[25A"); // up (30 - 5)
    expect(out).toContain("<PAYLOAD>");
  });

  it("does not erase on a same-position repaint (no flash)", () => {
    const b = box(5, 8);
    const out = composePaint("<P>", b, b, 30);
    // No space-fill erase sequence.
    expect(out).not.toContain("          "); // 10 spaces (cols)
    expect(out).toContain("<P>");
  });

  it("erases only the rows vacated when the band shrinks/moves", () => {
    // prev [5,13), now [5,10): rows 10,11,12 vacated → 3 erase lines
    const out = composePaint("<P>", box(5, 5), box(5, 8), 30);
    const eraseCount = (out.match(/ {10}/g) ?? []).length;
    expect(eraseCount).toBe(3);
  });

  it("erases all previous rows when the image is hidden (box null)", () => {
    const out = composePaint("", null, box(5, 4), 30);
    const eraseCount = (out.match(/ {10}/g) ?? []).length;
    expect(eraseCount).toBe(4);
    expect(out.startsWith(SAVE)).toBe(true);
    expect(out.endsWith(RESTORE)).toBe(true);
  });

  it("skips the payload when box is set but payload is empty (encode pending)", () => {
    const out = composePaint("", box(5, 8), null, 30);
    // Nothing vacated, nothing painted → just save/restore.
    expect(out).toBe(SAVE + RESTORE);
  });

  it("does not erase vacated rows that an occluding modal owns", () => {
    // Image hidden (box null) — all 4 prev rows [5,9) would normally be erased,
    // but a modal covers [5,9), so erasing would punch a hole in it. None erased.
    const out = composePaint("", null, box(5, 4), 30, [{ top: 5, rows: 4 }]);
    const eraseCount = (out.match(/ {10}/g) ?? []).length;
    expect(eraseCount).toBe(0);
  });

  it("erases only the vacated rows the modal does not cover", () => {
    // prev [5,9), modal covers [5,7); rows 5,6 owned by modal, 7,8 free → 2 erased
    const out = composePaint("", null, box(5, 4), 30, [{ top: 5, rows: 2 }]);
    const eraseCount = (out.match(/ {10}/g) ?? []).length;
    expect(eraseCount).toBe(2);
  });
});
