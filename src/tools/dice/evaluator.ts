import type { DiceExpression, DiceRollResult } from "../../types/dice.js";
import type { RNG } from "./rng.js";

const MAX_EXPLODE_DEPTH = 100; // safety limit for exploding dice

/**
 * Evaluate a parsed dice expression using the provided RNG.
 */
export function evaluate(expr: DiceExpression, rng: RNG): DiceRollResult {
  const rolls = rollDice(expr, rng);
  const kept = applyKeep(rolls, expr);
  const total = computeTotal(kept, expr);

  const result: DiceRollResult = {
    expression: formatExpression(expr),
    rolls,
    modifier: expr.modifier,
    total,
  };

  if (expr.keep) {
    result.kept = kept;
  }

  if (expr.successThreshold !== undefined) {
    const threshold = expr.successThreshold;
    result.successes = kept.filter((r) => r >= threshold).length;
    // For success counting, total is the success count, not the sum
    result.total = result.successes;
  }

  return result;
}

function rollDice(expr: DiceExpression, rng: RNG): number[] {
  const results: number[] = [];

  for (let i = 0; i < expr.count; i++) {
    if (expr.sides === "F") {
      // FATE dice: -1, 0, or +1
      results.push(rng.int(0, 2) - 1);
    } else if (expr.exploding) {
      // Exploding: reroll and add on max
      let roll = rng.int(1, expr.sides);
      let total = roll;
      let depth = 0;
      while (roll === expr.sides && depth < MAX_EXPLODE_DEPTH) {
        roll = rng.int(1, expr.sides);
        total += roll;
        depth++;
      }
      results.push(total);
    } else {
      results.push(rng.int(1, expr.sides));
    }
  }

  return results;
}

function applyKeep(rolls: number[], expr: DiceExpression): number[] {
  if (!expr.keep) return [...rolls];

  const sorted = [...rolls].sort((a, b) => a - b);

  if (expr.keep.highest) {
    return sorted.slice(-expr.keep.highest);
  }
  if (expr.keep.lowest) {
    return sorted.slice(0, expr.keep.lowest);
  }

  return [...rolls];
}

function computeTotal(kept: number[], expr: DiceExpression): number {
  if (expr.successThreshold !== undefined) {
    // Success counting — total is count of successes, no modifier
    const threshold = expr.successThreshold;
    return kept.filter((r) => r >= threshold).length;
  }

  const sum = kept.reduce((acc, val) => acc + val, 0);
  return sum + expr.modifier;
}

function formatExpression(expr: DiceExpression): string {
  let s = `${expr.count}d${expr.sides}`;
  if (expr.keep?.highest) s += `kh${expr.keep.highest}`;
  if (expr.keep?.lowest) s += `kl${expr.keep.lowest}`;
  if (expr.exploding) s += "!";
  if (expr.successThreshold !== undefined) s += `>=${expr.successThreshold}`;
  if (expr.modifier > 0) s += `+${expr.modifier}`;
  if (expr.modifier < 0) s += `${expr.modifier}`;
  return s;
}
