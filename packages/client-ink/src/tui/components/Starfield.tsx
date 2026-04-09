/**
 * Animated starfield background for the main menu.
 *
 * Stars fade in and out at random positions using OKLCH lightness animation.
 * Occasionally a "quasar" appears — a larger plus-shaped burst.
 *
 * Designed to run at 1 FPS for a slow, atmospheric effect.
 */

import React, { useRef } from "react";
import { Text, Box, useAnimation } from "ink";
import { oklchToHex } from "../color/oklch.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface StarfieldConfig {
  /** Stars per addressable cell (0–1). Default 0.025 */
  density?: number;
  /** Frames for a full fade-in + fade-out cycle. Default 60 */
  lifetime?: number;
  /** Probability that a new star is a quasar. Default 0.03 */
  quasarChance?: number;
  /** Animation interval in ms. Default 1000 (1 FPS) */
  interval?: number;
  /** Whether the animation is active. Default true */
  isActive?: boolean;
}

const DEFAULT_DENSITY = 0.025;
const DEFAULT_LIFETIME = 60;
const DEFAULT_QUASAR_CHANCE = 0.03;
const DEFAULT_INTERVAL = 1000;

// ---------------------------------------------------------------------------
// Star color palette (OKLCH)
// ---------------------------------------------------------------------------

export interface StarPalette {
  peakL: number;
  C: number;
  H: number;
  weight: number; // relative spawn probability
}

const PALETTE: StarPalette[] = [
  { peakL: 0.30, C: 0,    H: 0,   weight: 3 },   // dark/black
  { peakL: 0.90, C: 0,    H: 0,   weight: 4 },   // white
  { peakL: 0.75, C: 0.14, H: 65,  weight: 0.4 }, // orange (rare)
  { peakL: 0.55, C: 0.18, H: 25,  weight: 0.4 }, // red (rare)
  { peakL: 0.65, C: 0.18, H: 300, weight: 2 },   // violet
];

const TOTAL_WEIGHT = PALETTE.reduce((s, p) => s + p.weight, 0);

function pickColor(rng: () => number): StarPalette {
  let r = rng() * TOTAL_WEIGHT;
  for (const p of PALETTE) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  // Unreachable: r starts ≤ TOTAL_WEIGHT so the loop always returns.
  // Fallback satisfies the type checker.
  return PALETTE[PALETTE.length - 1] as StarPalette;
}

// ---------------------------------------------------------------------------
// Glyph selection by brightness
// ---------------------------------------------------------------------------

const GLYPH_TIERS = ["·", "∗", "✦", "★"] as const;
const GLYPH_THRESHOLDS = [0.20, 0.45, 0.70];

/**
 * Map normalized brightness (0–1) to a glyph that conveys intensity.
 * `maxTier` caps the brightest glyph (0 = ·, 3 = ★). Default 3.
 */
export function glyphForBrightness(t: number, maxTier = 3): string {
  let tier = 0;
  for (let i = 0; i < GLYPH_THRESHOLDS.length; i++) {
    if (t >= GLYPH_THRESHOLDS[i]) tier = i + 1;
  }
  return GLYPH_TIERS[Math.min(tier, maxTier)];
}

// ---------------------------------------------------------------------------
// Quasar shape
// ---------------------------------------------------------------------------

interface QuasarArm {
  dx: number;
  dy: number;
  glyph: string;
  /** Brightness multiplier relative to center. */
  bright: number;
}

const QUASAR_SHAPE: QuasarArm[] = [
  // Inner arms
  { dx: 0, dy: -1, glyph: "│", bright: 0.7 },
  { dx: -1, dy: 0, glyph: "─", bright: 0.7 },
  { dx: 0,  dy: 0, glyph: "╋", bright: 1.0 },
  { dx: 1,  dy: 0, glyph: "─", bright: 0.7 },
  { dx: 0,  dy: 1, glyph: "│", bright: 0.7 },
  // Outer tips
  { dx: 0, dy: -2, glyph: "·", bright: 0.35 },
  { dx: -2, dy: 0, glyph: "·", bright: 0.35 },
  { dx: 2,  dy: 0, glyph: "·", bright: 0.35 },
  { dx: 0,  dy: 2, glyph: "·", bright: 0.35 },
];

// ---------------------------------------------------------------------------
// Star data
// ---------------------------------------------------------------------------

export interface Star {
  x: number;
  y: number;
  birthFrame: number;
  lifetime: number;
  palette: StarPalette;
  isQuasar: boolean;
  /** Highest glyph tier this star can reach (1=∗, 2=✦, 3=★). */
  maxGlyphTier: number;
}

// ---------------------------------------------------------------------------
// Simple PRNG (mulberry32)
// ---------------------------------------------------------------------------

export function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Luminance curve
// ---------------------------------------------------------------------------

/**
 * Sine-cubed fade: 0 → 1 → 0 over a normalized lifetime [0, 1].
 * The cubic sharpens the peak so stars spend most of their life dim
 * and only briefly reach full brightness.
 */
export function fadeCurve(age: number, lifetime: number): number {
  if (age < 0 || age >= lifetime) return 0;
  const s = Math.sin((age / lifetime) * Math.PI);
  return s * s * s;
}

// ---------------------------------------------------------------------------
// Cell grid
// ---------------------------------------------------------------------------

function emptyGrid(width: number, height: number): (StarfieldCell | null)[][] {
  return Array.from({ length: height }, () =>
    Array.from<StarfieldCell | null>({ length: width }).fill(null),
  );
}

export interface StarfieldCell {
  glyph: string;
  color: string; // hex
}

// ---------------------------------------------------------------------------
// Mutable simulation state (lives in useRef)
// ---------------------------------------------------------------------------

interface SimState {
  stars: Star[];
  rng: () => number;
  lastFrame: number;
  dimKey: string;
}

function spawnStar(
  rng: () => number,
  frame: number,
  width: number,
  height: number,
  lifetime: number,
  quasarChance: number,
): Star {
  // 60% of stars cap at tier 1–2 (never reach ★), 40% can reach tier 3
  const tierRoll = rng();
  const maxGlyphTier = tierRoll < 0.25 ? 1 : tierRoll < 0.60 ? 2 : 3;

  return {
    x: Math.floor(rng() * width),
    y: Math.floor(rng() * height),
    birthFrame: frame,
    lifetime: Math.round(lifetime * (0.7 + rng() * 0.6)), // ±30% variation
    palette: pickColor(rng),
    isQuasar: rng() < quasarChance,
    maxGlyphTier,
  };
}

function advanceFrame(
  state: SimState,
  frame: number,
  width: number,
  height: number,
  lifetime: number,
  quasarChance: number,
  targetCount: number,
): void {
  // Expire dead stars
  state.stars = state.stars.filter(
    (s) => frame - s.birthFrame < s.lifetime,
  );

  // Spawn new stars toward target density, capped at the steady-state
  // replacement rate so the field fills in gradually from empty.
  const maxSpawnsPerFrame = Math.max(1, Math.ceil(targetCount / lifetime));
  const deficit = targetCount - state.stars.length;
  const toSpawn = Math.min(deficit, maxSpawnsPerFrame);
  for (let i = 0; i < toSpawn; i++) {
    state.stars.push(
      spawnStar(state.rng, frame, width, height, lifetime, quasarChance),
    );
  }
}

// ---------------------------------------------------------------------------
// Grid builder
// ---------------------------------------------------------------------------

export function buildGrid(
  stars: Star[],
  width: number,
  height: number,
  frame: number,
): (StarfieldCell | null)[][] {
  // Allocate grid
  const grid: (StarfieldCell | null)[][] = Array.from({ length: height }, () =>
    Array.from<StarfieldCell | null>({ length: width }).fill(null),
  );

  for (const star of stars) {
    const age = frame - star.birthFrame;
    const brightness = fadeCurve(age, star.lifetime);
    if (brightness <= 0) continue;

    if (star.isQuasar) {
      for (const arm of QUASAR_SHAPE) {
        const cx = star.x + arm.dx;
        const cy = star.y + arm.dy;
        if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;
        const row = grid[cy];
        if (!row || row[cx] !== null) continue; // don't overwrite
        const b = brightness * arm.bright;
        const L = b * star.palette.peakL;
        const C = b * star.palette.C;
        row[cx] = {
          glyph: arm.glyph,
          color: oklchToHex({ L, C, H: star.palette.H }),
        };
      }
    } else {
      if (star.x >= 0 && star.x < width && star.y >= 0 && star.y < height) {
        const row = grid[star.y];
        if (row && row[star.x] === null) {
          const L = brightness * star.palette.peakL;
          const C = brightness * star.palette.C;
          row[star.x] = {
            glyph: glyphForBrightness(brightness, star.maxGlyphTier),
            color: oklchToHex({ L, C, H: star.palette.H }),
          };
        }
      }
    }
  }

  return grid;
}

// ---------------------------------------------------------------------------
// Module-level cache so the starfield survives mount/unmount cycles
// (e.g. navigating to Settings and back).
// ---------------------------------------------------------------------------

const stateCache = new Map<string, SimState>();

/** Clear the cached starfield (useful in tests). */
export function resetStarfieldCache(): void {
  stateCache.clear();
}

// ---------------------------------------------------------------------------
// Hook: useStarfield
// ---------------------------------------------------------------------------

export function useStarfield(
  width: number,
  height: number,
  config: StarfieldConfig = {},
): (StarfieldCell | null)[][] {
  const density = config.density ?? DEFAULT_DENSITY;
  const lifetime = config.lifetime ?? DEFAULT_LIFETIME;
  const quasarChance = config.quasarChance ?? DEFAULT_QUASAR_CHANCE;
  const interval = config.interval ?? DEFAULT_INTERVAL;
  const isActive = config.isActive ?? true;

  const { frame } = useAnimation({ interval, isActive });

  const stateRef = useRef<SimState | null>(null);
  const frameOffsetRef = useRef(0);

  const dimKey = `${width}x${height}`;
  const area = width * height;
  const targetCount = Math.max(1, Math.round(area * density));

  // When inactive (starfield disabled), skip simulation and cache entirely.
  // Return an empty grid so other screens don't seed/pollute the cache.
  if (!isActive) {
    return emptyGrid(width, height);
  }

  // (Re-)initialize when dimensions change.
  // Check module-level cache first so stars survive mount/unmount.
  if (!stateRef.current || stateRef.current.dimKey !== dimKey) {
    const cached = stateCache.get(dimKey);
    if (cached) {
      stateRef.current = cached;
      // Resume: map animation frame 0 → the simulation frame after where we paused
      frameOffsetRef.current = cached.lastFrame + 1;
    } else {
      stateRef.current = { stars: [], rng: createRng(42), lastFrame: -1, dimKey };
      frameOffsetRef.current = 0;
    }
  }

  const state = stateRef.current;
  const simFrame = frame + frameOffsetRef.current;

  // Advance simulation to current frame (idempotent for same frame)
  while (state.lastFrame < simFrame) {
    state.lastFrame++;
    advanceFrame(
      state,
      state.lastFrame,
      width,
      height,
      lifetime,
      quasarChance,
      targetCount,
    );
  }

  // Persist to cache so state survives unmount
  stateCache.set(dimKey, state);

  return buildGrid(state.stars, width, height, simFrame);
}

// ---------------------------------------------------------------------------
// Component: StarfieldRow
// ---------------------------------------------------------------------------

interface StarfieldRowProps {
  cells: (StarfieldCell | null)[];
}

/**
 * Renders a single row of the starfield as batched colored spans.
 * Consecutive spaces are merged; consecutive same-color stars are merged.
 */
function StarfieldRow({ cells }: StarfieldRowProps) {
  const segments: React.ReactNode[] = [];
  let spaces = 0;

  const flushSpaces = () => {
    if (spaces > 0) {
      segments.push(" ".repeat(spaces));
      spaces = 0;
    }
  };

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (!cell) {
      spaces++;
      continue;
    }
    flushSpaces();

    // Batch consecutive cells with the same color
    let run = cell.glyph;
    while (i + 1 < cells.length && cells[i + 1]?.color === cell.color) {
      i++;
      run += (cells[i] as StarfieldCell).glyph;
    }
    segments.push(
      <Text key={i} color={cell.color}>
        {run}
      </Text>,
    );
  }
  flushSpaces();

  // Wrap in a single Text so segments lay out inline
  return <Text>{segments}</Text>;
}

// ---------------------------------------------------------------------------
// Component: StarfieldRows
// ---------------------------------------------------------------------------

export interface StarfieldRowsProps {
  grid: (StarfieldCell | null)[][];
  startRow: number;
  rowCount: number;
}

/**
 * Renders a slice of the starfield grid as a vertical stack of rows.
 */
export function StarfieldRows({ grid, startRow, rowCount }: StarfieldRowsProps) {
  const rows: React.ReactNode[] = [];
  for (let r = 0; r < rowCount; r++) {
    const gridRow = grid[startRow + r];
    if (!gridRow) continue;
    rows.push(<StarfieldRow key={r} cells={gridRow} />);
  }
  return <Box flexDirection="column">{rows}</Box>;
}
