import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";

interface NamePool {
  given: string[];
  family: string[];
}

let pool: NamePool | null = null;

function load(): NamePool {
  if (pool) return pool;
  const path = join(assetDir("assets"), "names", "names.json");
  pool = JSON.parse(readFileSync(path, "utf-8")) as NamePool;
  return pool;
}

/**
 * Pick `count` distinct entries from `arr` using `rng` (defaults to Math.random).
 * Partial Fisher-Yates over a copy of the source range.
 */
function sample<T>(arr: readonly T[], count: number, rng: () => number = Math.random): T[] {
  const n = Math.min(count, arr.length);
  const idx = arr.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).map((k) => arr[k]);
}

/**
 * Build the inspirational name hint for the DM prompt. The list is fresh
 * each session — its purpose is entropy injection, not authorial choice.
 *
 * Source pool is multicultural and globally shuffled; the DM is told these
 * are inspiration, not a hat to draw from. Override `rng` in tests.
 */
export function buildNameInspiration(
  count: { given: number; family: number } = { given: 30, family: 30 },
  rng: () => number = Math.random,
): string {
  const { given, family } = load();
  const givenSample = sample(given, count.given, rng);
  const familySample = sample(family, count.family, rng);
  return [
    "AI agents like you tend to favor the same names when creating characters.",
    "For inspiration only — don't feel bound to this list:",
    `Given names: ${givenSample.join(", ")}`,
    `Family names: ${familySample.join(", ")}`,
  ].join("\n");
}
