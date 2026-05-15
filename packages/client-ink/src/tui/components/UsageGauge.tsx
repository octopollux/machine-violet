/**
 * UsageGauge — 5-cell gem-themed remaining-usage indicator for the
 * bottom-right of the conversation pane.
 *
 * Reads the primary segment of the provider's UsageStatus (currently only
 * openai-chatgpt's 5-hour window) and renders five horizontally-packed
 * glyphs. The gauge is a unary countdown with 25 ticks (4% per tick): each
 * cell holds five ticks, the leftmost cell depletes first, and each cell
 * passes through five visual states as it drains:
 *
 *   ◆  light blue  (full)
 *   ⬢  red         (ruby)
 *   ■  brown       (garnet)
 *   *  grey        (tarnished)
 *   (space)        (empty)
 *
 * Because the user only specified four glyphs plus an empty cell, ticks 1
 * and 2 within a cell share the `*` rendering — visually compressing the
 * last 8% of a cell's drain into one state. The gauge still updates on
 * every 4% step; just the bottom two states look identical.
 *
 * The component renders nothing when the snapshot has no `primary` segment
 * or no usable `usedPercent` — providers without a usage concept never
 * mount it.
 */
import React from "react";
import { Text } from "ink";
import type { UsageStatus } from "@machine-violet/shared";

interface UsageGaugeProps {
  usage: UsageStatus | null;
}

interface Cell {
  glyph: string;
  color?: string;
}

const FULL: Cell = { glyph: "◆", color: "#529EAB" };       // light-blue diamond
const RUBY: Cell = { glyph: "⬢", color: "#781313" };       // red hexagon
const GARNET: Cell = { glyph: "■", color: "#A87712" };     // brown square
const TARNISHED: Cell = { glyph: "*", color: "gray" };     // grey asterisk
const EMPTY: Cell = { glyph: " " };

/**
 * Map a cell's bucket count (0-5) to its rendered cell. Buckets 1 and 2
 * collapse to the same `*` — see header comment.
 */
function cellFor(buckets: number): Cell {
  if (buckets >= 5) return FULL;
  if (buckets === 4) return RUBY;
  if (buckets === 3) return GARNET;
  if (buckets >= 1) return TARNISHED;
  return EMPTY;
}

/** Compute the 5 cells for a remaining-percentage value (0-100). */
export function gaugeCells(remainingPercent: number): Cell[] {
  // 25 total ticks → 4% per tick. Round to the nearest tick so we don't
  // bias high or low; clamp to [0, 25] in case the provider ever reports
  // negative or >100% remaining.
  const ticks = Math.max(0, Math.min(25, Math.round(remainingPercent / 4)));
  // Cells fill right-to-left: rightmost cell holds ticks 1-5, then 6-10,
  // etc. — so the leftmost cell is the first to empty.
  const cells: Cell[] = [];
  for (let i = 0; i < 5; i++) {
    const buckets = Math.max(0, Math.min(5, ticks - (4 - i) * 5));
    cells.push(cellFor(buckets));
  }
  return cells;
}

/** Return the primary segment's usedPercent, or null if unavailable. */
function primaryUsedPercent(usage: UsageStatus | null): number | null {
  if (!usage) return null;
  const primary = usage.segments.find((s) => s.id === "primary");
  if (!primary || primary.kind !== "percentage" || primary.usedPercent === undefined) {
    return null;
  }
  return primary.usedPercent;
}

export function UsageGauge({ usage }: UsageGaugeProps) {
  const usedPercent = primaryUsedPercent(usage);
  if (usedPercent === null) return null;

  const remaining = 100 - usedPercent;
  const cells = gaugeCells(remaining);
  return (
    <Text>
      {cells.map((c, i) => (
        <Text key={i} color={c.color}>{c.glyph}</Text>
      ))}
    </Text>
  );
}
