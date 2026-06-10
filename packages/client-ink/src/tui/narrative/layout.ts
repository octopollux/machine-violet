/**
 * Width-correct line layout for the DM narrative pipeline.
 *
 * Unlike the legacy `wrapNodes` (which the modals still use, and which measures
 * code units and never breaks long tokens or wraps alignment), this engine:
 *   - measures by DISPLAY width (the real `string-width`, matching Ink's layout),
 *   - hard-breaks a single token wider than the row,
 *   - splits a run on `linebreak` (`<br>`) leaves into independent rows,
 *   - keeps wikilinks atomic and preserves tag structure across rows.
 *
 * It is the load-bearing fix for INV-WIDTH: every physical row it emits fits the
 * target width. Aligned blocks pass their inner content through `layoutRuns` and
 * pad each resulting row, which is what lets a multi-line `<br>` sign render as N
 * width-safe centered rows instead of one overflowing line.
 */
import type { FormattingNode, FormattingTag } from "@machine-violet/shared/types/tui.js";
import { stringWidth } from "../frames/string-width.js";
import { toPlainText, nodeDisplayWidth, flattenToWords } from "../formatting.js";

/**
 * Left rule glyph the Ink renderer prefixes to every `<quote>` row. U+258F LEFT
 * ONE EIGHTH BLOCK — a thin, full-height vertical bar that reads as a blockquote
 * border without stealing a full column of ink. The pipeline reserves
 * {@link QUOTE_PREFIX_COLS} columns (rule + one space) when wrapping quote
 * content, so the prefixed row still fits the target width (INV-WIDTH).
 */
export const QUOTE_RULE = "▏";
/** Columns reserved for the quote rule + its trailing space. */
export const QUOTE_PREFIX_COLS = 2;

/**
 * Lay out an inline run into physical rows that each fit `width` display columns.
 * Splits on `<br>` leaves first, then word-wraps each segment. With `width <= 0`
 * returns the nodes unwrapped (a single row) — callers use 0 to disable wrapping.
 */
export function layoutRuns(nodes: FormattingNode[], width: number): FormattingNode[][] {
  if (width <= 0) return [nodes];
  const rows: FormattingNode[][] = [];
  for (const segment of splitOnLinebreaks(nodes)) {
    for (const row of wrapSegment(segment, width)) rows.push(row);
  }
  return rows.length > 0 ? rows : [nodes];
}

/**
 * Split a node array at `linebreak` leaves into segments, preserving tag nesting
 * across the break (so `<b>a<br>b</b>` → `[<b>a</b>], [<b>b</b>]`).
 */
export function splitOnLinebreaks(nodes: FormattingNode[]): FormattingNode[][] {
  const segments: FormattingNode[][] = [[]];
  const push = (n: FormattingNode) => segments[segments.length - 1].push(n);
  for (const node of nodes) {
    if (typeof node === "string") { push(node); continue; }
    if (node.type === "linebreak") { segments.push([]); continue; }
    if (!("content" in node)) { push(node); continue; }
    const inner = splitOnLinebreaks(node.content);
    for (let k = 0; k < inner.length; k++) {
      const wrapped = { ...node, content: inner[k] } as FormattingTag;
      if (k === 0) push(wrapped);
      else segments.push([wrapped]);
    }
  }
  return segments;
}

/** Greedy word-wrap one linebreak-free run by display width, hard-breaking any
 *  single token that is wider than the row. */
function wrapSegment(nodes: FormattingNode[], width: number): FormattingNode[][] {
  if (nodeDisplayWidth(nodes) <= width) return [nodes];

  const raw: { nodes: FormattingNode[]; visible: number }[] = [];
  flattenToWords(nodes, raw);
  const words = raw.map((w) => ({ nodes: w.nodes, width: nodeDisplayWidth(w.nodes) }));
  if (words.length === 0) return [nodes];

  const rows: FormattingNode[][] = [];
  let cur: FormattingNode[] = [];
  let curW = 0;
  const flush = () => { if (cur.length > 0) { rows.push(cur); cur = []; curW = 0; } };

  for (const word of words) {
    if (word.width > width) {
      // A single token wider than the row — break it across rows so no row
      // overflows. The current row is flushed first so the break starts clean.
      flush();
      const broken = hardBreak(word.nodes, width);
      if (broken.length === 0) { rows.push(word.nodes); continue; }
      // All but the last broken chunk are complete rows; the last seeds `cur`
      // so the next word can continue on the same row if it fits.
      for (let k = 0; k < broken.length - 1; k++) rows.push(broken[k]);
      cur = broken[broken.length - 1];
      curW = nodeDisplayWidth(cur);
      continue;
    }
    if (curW > 0 && curW + 1 + word.width > width) flush();
    if (curW > 0) { cur.push(" "); curW += 1; }
    cur.push(...word.nodes);
    curW += word.width;
  }
  flush();
  return rows.length > 0 ? rows : [nodes];
}

/**
 * Hard-break one over-width word fragment into rows that each fit `width`,
 * preserving tag structure. Handles arbitrary fragments — a plain long token, a
 * styled run (`<color>████…</color>`), a styled run with glued punctuation
 * (`…</color>.`), or nested tags — by walking the fragment and emitting
 * width-bounded pieces, re-wrapping each in its enclosing tags.
 */
function hardBreak(nodes: FormattingNode[], width: number): FormattingNode[][] {
  const rows = chunkNodes(nodes, Math.max(1, width));
  return rows.length > 0 ? rows : [nodes];
}

function chunkNodes(nodes: FormattingNode[], max: number): FormattingNode[][] {
  const rows: FormattingNode[][] = [[]];
  let curW = 0;
  const newRow = () => { rows.push([]); curW = 0; };

  const emitString = (s: string) => {
    let buf = "";
    let bw = 0;
    for (const ch of s) {
      const cw = stringWidth(ch);
      if (curW + bw + cw > max && curW + bw > 0) {
        if (buf) { rows[rows.length - 1].push(buf); buf = ""; bw = 0; }
        newRow();
      }
      buf += ch;
      bw += cw;
    }
    if (buf) { rows[rows.length - 1].push(buf); curW += bw; }
  };

  const walk = (ns: FormattingNode[]) => {
    for (const n of ns) {
      if (typeof n === "string") { emitString(n); continue; }
      if (n.type === "linebreak") continue; // a word never contains a hard break
      if (!("content" in n)) continue;
      // Break the tag's content into rows, then re-wrap each row-slice in a copy
      // of the tag; each inner row boundary forces a new outer row.
      const inner = chunkNodes(n.content, max);
      for (let k = 0; k < inner.length; k++) {
        if (k > 0) newRow();
        const wrapped = { ...n, content: inner[k] } as FormattingTag;
        const w = nodeDisplayWidth([wrapped]);
        if (curW + w > max && curW > 0) newRow();
        rows[rows.length - 1].push(wrapped);
        curW += w;
      }
    }
  };

  walk(nodes);
  return rows;
}

// Re-export for layout tests that need the display measure without reaching
// through formatting.ts.
export { nodeDisplayWidth, toPlainText };
