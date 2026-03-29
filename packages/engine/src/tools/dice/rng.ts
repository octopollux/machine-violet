import { randomInt } from "node:crypto";

/**
 * Random number generator interface. Allows seeded RNG for tests
 * and crypto-secure random for production.
 */
export interface RNG {
  /** Returns a random integer in [min, max] inclusive */
  int(min: number, max: number): number;
}

/** Production RNG using Node's crypto module */
export const cryptoRng: RNG = {
  int(min: number, max: number): number {
    return randomInt(min, max + 1); // randomInt upper bound is exclusive
  },
};

/**
 * Seeded RNG for deterministic testing.
 * Uses a simple linear congruential generator.
 */
export function seededRng(seed: number): RNG {
  let state = seed;
  return {
    int(min: number, max: number): number {
      // LCG parameters from Numerical Recipes
      state = (state * 1664525 + 1013904223) >>> 0;
      const range = max - min + 1;
      return min + (state % range);
    },
  };
}
