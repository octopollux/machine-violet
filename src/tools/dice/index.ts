import type { RollDiceInput, RollDiceOutput, DiceRollResult } from "../../types/dice.js";
import type { RNG } from "./rng.js";
import { cryptoRng } from "./rng.js";
import { parseMulti } from "./parser.js";
import { evaluate } from "./evaluator.js";

export { seededRng, cryptoRng } from "./rng.js";
export { parseExpression, parseMulti } from "./parser.js";
export { evaluate } from "./evaluator.js";

/**
 * The roll_dice tool. Parses expression(s), rolls, validates claimed results.
 */
export function rollDice(
  input: RollDiceInput,
  rng: RNG = cryptoRng,
): RollDiceOutput {
  // Handle claimed results (player-rolled physical dice)
  if (input.claimed_result) {
    return validateClaim(input);
  }

  const expressions = parseMulti(input.expression);
  const results: DiceRollResult[] = expressions.map((expr) => {
    const result = evaluate(expr, rng);
    if (input.reason) {
      result.reason = input.reason;
    }
    return result;
  });

  return { results };
}

/**
 * Validate a player's claimed dice result.
 * Checks that the claim is physically possible for the given expression.
 */
function validateClaim(input: RollDiceInput): RollDiceOutput {
  const expressions = parseMulti(input.expression);
  const claim = input.claimed_result;
  if (!claim) throw new Error("validateClaim requires claimed_result");

  if (expressions.length !== 1) {
    throw new Error("Claimed results only supported for single expressions");
  }

  const expr = expressions[0];

  if (expr.sides === "F") {
    // FATE dice: each die is -1, 0, or +1
    for (const roll of claim.rolls) {
      if (roll < -1 || roll > 1) {
        throw new Error(
          `Invalid FATE die result: ${roll} (must be -1, 0, or +1)`,
        );
      }
    }
  } else if (!expr.exploding) {
    // Standard dice: each die is [1, sides]
    for (const roll of claim.rolls) {
      if (roll < 1 || roll > expr.sides) {
        throw new Error(
          `Invalid die result: ${roll} on d${expr.sides} (must be 1-${expr.sides})`,
        );
      }
    }
  }
  // Exploding dice can have values > sides, so we skip individual validation

  if (claim.rolls.length !== expr.count) {
    throw new Error(
      `Expected ${expr.count} dice, got ${claim.rolls.length}`,
    );
  }

  // Verify the claimed total
  const kept = expr.keep
    ? applyKeepForClaim(claim.rolls, expr)
    : claim.rolls;
  const expectedTotal = kept.reduce((a, b) => a + b, 0) + expr.modifier;

  if (claim.total !== expectedTotal) {
    throw new Error(
      `Claimed total ${claim.total} doesn't match computed total ${expectedTotal}`,
    );
  }

  const result: DiceRollResult = {
    expression: input.expression,
    rolls: claim.rolls,
    modifier: expr.modifier,
    total: claim.total,
    reason: input.reason,
  };

  if (expr.keep) {
    result.kept = kept;
  }

  return { results: [result] };
}

function applyKeepForClaim(
  rolls: number[],
  expr: { keep?: { highest?: number; lowest?: number } },
): number[] {
  if (!expr.keep) return rolls;
  const sorted = [...rolls].sort((a, b) => a - b);
  if (expr.keep.highest) return sorted.slice(-expr.keep.highest);
  if (expr.keep.lowest) return sorted.slice(0, expr.keep.lowest);
  return rolls;
}
