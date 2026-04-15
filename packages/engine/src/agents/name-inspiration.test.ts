import { describe, it, expect } from "vitest";
import { buildNameInspiration } from "./name-inspiration.js";

/** Deterministic mulberry32 PRNG for reproducible samples in tests. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("buildNameInspiration", () => {
  it("renders the framing hint and both lists with the requested counts", () => {
    const text = buildNameInspiration({ given: 5, family: 7 }, seeded(1));
    expect(text).toContain("AI agents like you tend to favor the same names");
    expect(text).toContain("inspiration only");

    const givenLine = text.split("\n").find((l) => l.startsWith("Given names:"));
    const familyLine = text.split("\n").find((l) => l.startsWith("Family names:"));
    expect(givenLine).toBeDefined();
    expect(familyLine).toBeDefined();
    expect(givenLine!.replace("Given names: ", "").split(", ")).toHaveLength(5);
    expect(familyLine!.replace("Family names: ", "").split(", ")).toHaveLength(7);
  });

  it("samples without duplicates within each list", () => {
    const text = buildNameInspiration({ given: 30, family: 30 }, seeded(42));
    const given = text.split("\n").find((l) => l.startsWith("Given names:"))!.replace("Given names: ", "").split(", ");
    const family = text.split("\n").find((l) => l.startsWith("Family names:"))!.replace("Family names: ", "").split(", ");
    expect(new Set(given).size).toBe(given.length);
    expect(new Set(family).size).toBe(family.length);
  });

  it("produces different samples on different RNG seeds (entropy guard)", () => {
    const a = buildNameInspiration({ given: 30, family: 30 }, seeded(1));
    const b = buildNameInspiration({ given: 30, family: 30 }, seeded(2));
    expect(a).not.toBe(b);
  });
});
