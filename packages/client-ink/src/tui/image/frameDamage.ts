/**
 * Frame-damage analysis for the inline-image painter's re-blit decision.
 *
 * The painter's steady-state skip ("the pixels I blitted last frame are still
 * on screen, emit nothing") is only sound when Ink's frame left the image's
 * rows untouched. That premise fails in several real paths:
 *
 *  - On Windows, Ink (7.0.6) clears the terminal and rewrites the WHOLE frame
 *    for every fullscreen render (its ConPTY workaround) — the incremental
 *    per-line diff never runs, so ANY frame wipes the pixels.
 *  - `log.clear()` + full rewrite (console patch / external writes, resize).
 *  - An incremental diff that rewrites the image's slot rows because text
 *    moved across them (scroll bursts where a throttled text frame lands
 *    after the layout already advanced).
 *
 * In all of those the painter's signature (position/band/raster) is unchanged,
 * so it would skip — and the image stays blank until something moves it. This
 * module inspects the exact byte block Ink is about to flush and reports which
 * rows the block writes or erases, so the painter can skip only when its rows
 * were genuinely left alone.
 *
 * Coordinates: the block's cursor movements are relative (Ink repaints from
 * the frame's resting cursor position), so damage is reported as DISTANCE
 * ABOVE THE BLOCK-END CURSOR ROW — the same reference the painter uses to
 * position its blits (`up(cursorRow - row)` from the resting cursor). That
 * keeps the comparison anchored even when strays have pushed the frame.
 *
 * The grammar covers exactly what Ink's renderer emits (relative cursor moves,
 * per-line erases, SGR, cursor-visibility + synchronized-update modes, OSC).
 * Anything unrecognized — absolute jumps, erase-in-display, scroll/insert/
 * delete, DCS, unknown finals — conservatively reports FULL damage, which
 * costs at worst one redundant re-blit, never a missing image.
 */

export type FrameDamage =
  | { readonly full: true }
  | { readonly full: false; readonly rowsAboveCursor: ReadonlySet<number> };

export const FULL_DAMAGE: FrameDamage = { full: true };
export const NO_DAMAGE: FrameDamage = { full: false, rowsAboveCursor: new Set() };

const isParamByte = (ch: string): boolean =>
  (ch >= "0" && ch <= "9") || ch === ";" || ch === "?" || ch === "<" || ch === "=" || ch === ">" || ch === ":";
const isIntermediateByte = (ch: string): boolean => ch >= " " && ch <= "/";

/** First numeric CSI param, with a default for empty/zero (ANSI semantics). */
function firstParam(params: string, fallback: number): number {
  const v = Number.parseInt(params.replace(/^[?<=>]/, "").split(";")[0], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Analyze one synchronized-output block (the bytes Ink wrote between BSU and
 * ESU, before the painter injection) and report the rows it damaged.
 */
export function analyzeFrameDamage(block: string): FrameDamage {
  let row = 0; // relative to the cursor row at block start
  let savedRow: number | null = null;
  const damaged = new Set<number>();
  const n = block.length;
  let i = 0;

  while (i < n) {
    const ch = block[i];

    if (ch === "\x1b") {
      const next = block[i + 1];

      if (next === "[") {
        // CSI: ESC [ params intermediates final
        let j = i + 2;
        while (j < n && isParamByte(block[j])) j++;
        while (j < n && isIntermediateByte(block[j])) j++;
        if (j >= n) return FULL_DAMAGE; // truncated sequence
        const final = block[j];
        const params = block.slice(i + 2, j);
        switch (final) {
          case "A": row -= firstParam(params, 1); break;           // cursor up
          case "B": row += firstParam(params, 1); break;           // cursor down
          case "E": row += firstParam(params, 1); break;           // next line
          case "F": row -= firstParam(params, 1); break;           // prev line
          case "C": case "D": case "G": break;                     // column-only moves
          case "m": break;                                         // SGR
          case "t": break;                                         // window ops / queries
          case "K": damaged.add(row); break;                       // erase-in-line
          case "h": case "l": {
            // Private modes: cursor visibility (25) and synchronized update
            // (2026) are row-neutral. Anything else (alt screen, origin mode,
            // scroll regions…) changes screen semantics → full.
            const modes = params.startsWith("?") ? params.slice(1).split(";") : null;
            if (modes && modes.every((m) => m === "25" || m === "2026")) break;
            return FULL_DAMAGE;
          }
          // Absolute jumps lose the relative anchor; erase-in-display,
          // insert/delete/scroll shift arbitrary rows. All conservative-full.
          default: return FULL_DAMAGE;
        }
        i = j + 1;
        continue;
      }

      if (next === "7") { savedRow = row; i += 2; continue; }       // DECSC
      if (next === "8") {                                           // DECRC
        if (savedRow === null) return FULL_DAMAGE;
        row = savedRow;
        i += 2;
        continue;
      }

      if (next === "]") {
        // OSC … (BEL | ST): row-neutral (titles, hyperlinks).
        let j = i + 2;
        while (j < n && block[j] !== "\x07" && !(block[j] === "\x1b" && block[j + 1] === "\\")) j++;
        if (j >= n) return FULL_DAMAGE;
        i = block[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }

      // DCS/APC/PM/SOS payloads, RIS, unknown escapes → conservative full.
      return FULL_DAMAGE;
    }

    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row += 1; i++; continue; }
    if (ch === "\x07" || ch === "\b" || ch === "\t") { i++; continue; } // column/bell only
    if (ch < " " || ch === "\x7f") return FULL_DAMAGE;                  // unknown C0

    // Printable run: text written on the current row.
    damaged.add(row);
    while (i < n && block[i] >= " " && block[i] !== "\x7f" && block[i] !== "\x1b") i++;
  }

  if (damaged.size === 0) return NO_DAMAGE;
  const rowsAboveCursor = new Set<number>();
  for (const r of damaged) rowsAboveCursor.add(row - r);
  return { full: false, rowsAboveCursor };
}

/**
 * Did the frame repaint exactly `row`? Unlike `damageTouches` this is an
 * EXACT check (no slop): it gates the vacated-row erase, where the two error
 * directions differ — erasing a row Ink just wrote text into destroys the
 * text (the "scroll punches blank holes in the narrative" bug), while not
 * erasing a genuinely stale row only risks a one-frame ghost that the next
 * frame's own rewrite clears.
 */
export function damagedAtRow(damage: FrameDamage, row: number, cursorRow: number): boolean {
  if (damage.full) return true;
  return damage.rowsAboveCursor.has(cursorRow - row);
}

/**
 * Did `damage` touch any row of the span [`topRow`, `topRow + rows`)?
 * `cursorRow` is the 0-based app row the cursor rests on after the block (the
 * painter's positioning anchor). Compared with ±1 slop so a one-row
 * calibration difference between the analyzer and the painter can never turn
 * a real clobber into a false skip.
 */
export function damageTouches(
  damage: FrameDamage,
  topRow: number,
  rows: number,
  cursorRow: number,
): boolean {
  if (damage.full) return true;
  if (damage.rowsAboveCursor.size === 0) return false;
  for (let r = topRow; r < topRow + rows; r++) {
    const d = cursorRow - r;
    if (
      damage.rowsAboveCursor.has(d - 1) ||
      damage.rowsAboveCursor.has(d) ||
      damage.rowsAboveCursor.has(d + 1)
    ) {
      return true;
    }
  }
  return false;
}
