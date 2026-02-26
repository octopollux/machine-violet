import { describe, it, expect } from "vitest";
import { parseExpression, parseMulti } from "./parser.js";
import { evaluate } from "./evaluator.js";
import { rollDice, seededRng } from "./index.js";

describe("dice parser", () => {
  it("parses basic expressions", () => {
    const expr = parseExpression("3d6");
    expect(expr.count).toBe(3);
    expect(expr.sides).toBe(6);
    expect(expr.modifier).toBe(0);
  });

  it("parses modifiers", () => {
    expect(parseExpression("1d20+5").modifier).toBe(5);
    expect(parseExpression("2d8-1").modifier).toBe(-1);
  });

  it("parses keep highest", () => {
    const expr = parseExpression("4d6kh3");
    expect(expr.count).toBe(4);
    expect(expr.keep).toEqual({ highest: 3 });
  });

  it("parses keep lowest", () => {
    const expr = parseExpression("2d20kl1");
    expect(expr.keep).toEqual({ lowest: 1 });
  });

  it("parses exploding dice", () => {
    const expr = parseExpression("3d6!");
    expect(expr.exploding).toBe(true);
  });

  it("parses success counting", () => {
    const expr = parseExpression("6d10>=7");
    expect(expr.successThreshold).toBe(7);
  });

  it("parses FATE dice", () => {
    const expr = parseExpression("4dF");
    expect(expr.count).toBe(4);
    expect(expr.sides).toBe("F");
  });

  it("parses combined notation", () => {
    const expr = parseExpression("2d20kh1+5");
    expect(expr.count).toBe(2);
    expect(expr.sides).toBe(20);
    expect(expr.keep).toEqual({ highest: 1 });
    expect(expr.modifier).toBe(5);
  });

  it("parses multi-expressions", () => {
    const exprs = parseMulti("1d20+5; 1d8+3");
    expect(exprs).toHaveLength(2);
    expect(exprs[0].sides).toBe(20);
    expect(exprs[1].sides).toBe(8);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseExpression("banana")).toThrow("Invalid dice expression");
    expect(() => parseExpression("3d0")).toThrow("Invalid die size");
  });

  it("rejects exploding d1", () => {
    expect(() => parseExpression("3d1!")).toThrow("d1 cannot explode");
  });

  it("rejects exploding FATE dice", () => {
    expect(() => parseExpression("4dF!")).toThrow("FATE dice cannot explode");
  });

  it("handles 0d6", () => {
    const expr = parseExpression("0d6");
    expect(expr.count).toBe(0);
  });
});

describe("dice evaluator", () => {
  it("rolls basic dice deterministically with seeded RNG", () => {
    const testRng = seededRng(42);
    const expr = parseExpression("3d6");
    const result = evaluate(expr, testRng);
    expect(result.rolls).toHaveLength(3);
    result.rolls.forEach((r) => {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
    });
    expect(result.total).toBe(result.rolls.reduce((a, b) => a + b, 0));
  });

  it("applies modifiers correctly", () => {
    const testRng = seededRng(99);
    const expr = parseExpression("1d20+5");
    const result = evaluate(expr, testRng);
    expect(result.total).toBe(result.rolls[0] + 5);
    expect(result.modifier).toBe(5);
  });

  it("applies keep highest", () => {
    const testRng = seededRng(7);
    const expr = parseExpression("4d6kh3");
    const result = evaluate(expr, testRng);
    expect(result.rolls).toHaveLength(4);
    expect(result.kept).toHaveLength(3);
    // kept should be the 3 highest values
    const sorted = [...result.rolls].sort((a, b) => a - b);
    expect(result.kept!.sort((a, b) => a - b)).toEqual(sorted.slice(1));
  });

  it("applies keep lowest", () => {
    const testRng = seededRng(7);
    const expr = parseExpression("2d20kl1");
    const result = evaluate(expr, testRng);
    expect(result.rolls).toHaveLength(2);
    expect(result.kept).toHaveLength(1);
    expect(result.kept![0]).toBe(Math.min(...result.rolls));
  });

  it("counts successes", () => {
    const testRng = seededRng(42);
    const expr = parseExpression("6d10>=7");
    const result = evaluate(expr, testRng);
    expect(result.rolls).toHaveLength(6);
    expect(result.successes).toBeDefined();
    expect(result.total).toBe(result.successes);
    const manualCount = result.rolls.filter((r) => r >= 7).length;
    expect(result.successes).toBe(manualCount);
  });

  it("rolls FATE dice", () => {
    const testRng = seededRng(42);
    const expr = parseExpression("4dF");
    const result = evaluate(expr, testRng);
    expect(result.rolls).toHaveLength(4);
    result.rolls.forEach((r) => {
      expect(r).toBeGreaterThanOrEqual(-1);
      expect(r).toBeLessThanOrEqual(1);
    });
  });

  it("handles 0 dice", () => {
    const testRng = seededRng(42);
    const expr = parseExpression("0d6+3");
    const result = evaluate(expr, testRng);
    expect(result.rolls).toHaveLength(0);
    expect(result.total).toBe(3);
  });

  it("seeded RNG is deterministic", () => {
    const rng1 = seededRng(42);
    const rng2 = seededRng(42);
    const expr = parseExpression("5d20");
    const result1 = evaluate(expr, rng1);
    const result2 = evaluate(expr, rng2);
    expect(result1.rolls).toEqual(result2.rolls);
  });
});

describe("rollDice (full tool)", () => {
  it("handles a simple roll", () => {
    const output = rollDice(
      { expression: "1d20+5", reason: "attack roll" },
      seededRng(42),
    );
    expect(output.results).toHaveLength(1);
    expect(output.results[0].reason).toBe("attack roll");
    expect(output.results[0].modifier).toBe(5);
  });

  it("handles multi-expression", () => {
    const output = rollDice(
      { expression: "1d20+5; 1d8+3", reason: "attack and damage" },
      seededRng(42),
    );
    expect(output.results).toHaveLength(2);
  });

  it("validates a valid claimed result", () => {
    const output = rollDice({
      expression: "1d20+5",
      claimed_result: { rolls: [18], total: 23 },
    });
    expect(output.results[0].total).toBe(23);
    expect(output.results[0].rolls).toEqual([18]);
  });

  it("rejects impossible claimed roll value", () => {
    expect(() =>
      rollDice({
        expression: "1d20+5",
        claimed_result: { rolls: [25], total: 30 },
      }),
    ).toThrow("Invalid die result: 25 on d20");
  });

  it("rejects wrong number of dice in claim", () => {
    expect(() =>
      rollDice({
        expression: "2d6",
        claimed_result: { rolls: [3], total: 3 },
      }),
    ).toThrow("Expected 2 dice, got 1");
  });

  it("rejects wrong total in claim", () => {
    expect(() =>
      rollDice({
        expression: "1d20+5",
        claimed_result: { rolls: [10], total: 20 },
      }),
    ).toThrow("doesn't match computed total 15");
  });

  it("validates claimed results with keep highest", () => {
    const output = rollDice({
      expression: "2d20kh1+5",
      claimed_result: { rolls: [18, 7], total: 23 },
    });
    expect(output.results[0].total).toBe(23);
    expect(output.results[0].kept).toEqual([18]);
  });

  it("validates FATE dice claims", () => {
    const output = rollDice({
      expression: "4dF",
      claimed_result: { rolls: [1, -1, 0, 1], total: 1 },
    });
    expect(output.results[0].total).toBe(1);
  });

  it("rejects invalid FATE die value", () => {
    expect(() =>
      rollDice({
        expression: "4dF",
        claimed_result: { rolls: [1, -1, 2, 0], total: 2 },
      }),
    ).toThrow("Invalid FATE die result: 2");
  });
});
