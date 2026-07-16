import { describe, it, expect } from "vitest";
import { coerceResourceKeys } from "./resource-keys.js";

describe("coerceResourceKeys", () => {
  it("passes a well-formed array through", () => {
    expect(coerceResourceKeys(["HP", "Spell Slots"])).toEqual(["HP", "Spell Slots"]);
    expect(coerceResourceKeys([])).toEqual([]);
  });

  it("wraps a bare single-key string instead of splitting it into characters", () => {
    // The regression this exists to prevent: a DM that carried the sheet's
    // comma-separated front-matter convention into the tool call handed us
    // "Stress", and every `for (const key of keys)` consumer walked the
    // characters — the top frame rendered `S | t | r | e | s | s`.
    expect(coerceResourceKeys("Stress")).toEqual(["Stress"]);
  });

  it("splits a comma-separated string on commas, honoring the front-matter convention", () => {
    expect(coerceResourceKeys("HP, Spell Slots")).toEqual(["HP", "Spell Slots"]);
    // Tolerates missing/extra spacing around the separator.
    expect(coerceResourceKeys("HP,Spell Slots")).toEqual(["HP", "Spell Slots"]);
    expect(coerceResourceKeys("HP ,  Spell Slots ")).toEqual(["HP", "Spell Slots"]);
  });

  it("drops empty segments rather than emitting blank keys", () => {
    expect(coerceResourceKeys("HP,,Spell Slots")).toEqual(["HP", "Spell Slots"]);
    expect(coerceResourceKeys("HP,")).toEqual(["HP"]);
    expect(coerceResourceKeys(",")).toEqual([]);
    expect(coerceResourceKeys("   ")).toEqual([]);
    expect(coerceResourceKeys("")).toEqual([]);
  });

  it("trims array elements and drops blank ones", () => {
    expect(coerceResourceKeys([" HP ", "", "  ", "Coin"])).toEqual(["HP", "Coin"]);
  });

  it("does not split array elements — an array is already the intended shape", () => {
    // A key legitimately containing a comma survives when sent as an array.
    // Only the string form is ambiguous enough to warrant splitting.
    expect(coerceResourceKeys(["Wounds, Minor"])).toEqual(["Wounds, Minor"]);
  });

  it("stringifies numeric elements and discards non-scalar ones", () => {
    expect(coerceResourceKeys([1, "HP"])).toEqual(["1", "HP"]);
    expect(coerceResourceKeys([{ HP: "1/2" }, ["HP"], null, undefined, "Coin"])).toEqual(["Coin"]);
  });

  it("yields an empty list for absent or non-coercible input", () => {
    // A character with no resource line is a normal state, not an error.
    expect(coerceResourceKeys(undefined)).toEqual([]);
    expect(coerceResourceKeys(null)).toEqual([]);
    expect(coerceResourceKeys(42)).toEqual([]);
    expect(coerceResourceKeys({ HP: "24/30" })).toEqual([]);
  });

  it("is idempotent", () => {
    for (const input of ["Stress", "HP, Spell Slots", ["HP", "Coin"], "", null]) {
      const once = coerceResourceKeys(input);
      expect(coerceResourceKeys(once)).toEqual(once);
    }
  });

  it("returns a fresh array, never the caller's", () => {
    const input = ["HP"];
    expect(coerceResourceKeys(input)).not.toBe(input);
  });
});
