import type { DiceExpression } from "@machine-violet/shared/types/dice.js";

/**
 * Parse a dice notation string into a structured expression.
 *
 * Supported formats:
 *   3d6         basic
 *   1d20+5      with modifier
 *   2d8-1       negative modifier
 *   4d6kh3      keep highest 3
 *   2d20kl1     keep lowest 1
 *   3d6!        exploding (reroll and add on max)
 *   6d10>=7     success counting (count dice >= threshold)
 *   4dF         FATE dice (-1, 0, +1 each)
 *   1d20+5; 1d8+3  multi-expression (semicolon-separated)
 */

const DICE_REGEX =
  /^(\d+)d(\d+|F|%)(kh\d+|kl\d+)?(!)?(>=\d+)?([+-]\d+)?$/;

export function parseExpression(input: string): DiceExpression {
  const trimmed = input.trim();
  const match = trimmed.match(DICE_REGEX);
  if (!match) {
    throw new Error(`Invalid dice expression: "${input}"`);
  }

  const [, countStr, sidesStr, keepStr, exploding, successStr, modStr] = match;

  const count = parseInt(countStr, 10);
  const sides: number | "F" = sidesStr === "F" ? "F" : sidesStr === "%" ? 100 : parseInt(sidesStr, 10);

  if (typeof sides === "number" && sides < 1) {
    throw new Error(`Invalid die size: d${sides}`);
  }
  if (count < 0) {
    throw new Error(`Invalid die count: ${count}`);
  }

  const expr: DiceExpression = {
    count,
    sides,
    modifier: modStr ? parseInt(modStr, 10) : 0,
  };

  if (keepStr) {
    if (keepStr.startsWith("kh")) {
      expr.keep = { highest: parseInt(keepStr.slice(2), 10) };
    } else if (keepStr.startsWith("kl")) {
      expr.keep = { lowest: parseInt(keepStr.slice(2), 10) };
    }
  }

  if (exploding) {
    if (sides === "F") {
      throw new Error("FATE dice cannot explode");
    }
    if (sides === 1) {
      throw new Error("d1 cannot explode (infinite loop)");
    }
    expr.exploding = true;
  }

  if (successStr) {
    expr.successThreshold = parseInt(successStr.slice(2), 10);
  }

  return expr;
}

/**
 * Parse a full dice string, which may contain multiple semicolon-separated expressions.
 */
export function parseMulti(input: string): DiceExpression[] {
  return input.split(";").map((part) => parseExpression(part));
}
