import { describe, it, expect, beforeEach } from "vitest";
import type { DecksState } from "@machine-violet/shared/types/cards.js";
import { deck, createDecksState, createStandard52, createTarot } from "./index.js";
import { seededRng } from "../dice/rng.js";

const rng = seededRng(42);
let state: DecksState;

beforeEach(() => {
  state = createDecksState();
});

describe("deck templates", () => {
  it("standard 52 has 52 cards", () => {
    expect(createStandard52()).toHaveLength(52);
  });

  it("standard 52 has unique raw values", () => {
    const cards = createStandard52();
    const raws = new Set(cards.map((c) => c.raw));
    expect(raws.size).toBe(52);
  });

  it("tarot has 78 cards (22 major + 56 minor)", () => {
    const cards = createTarot();
    expect(cards).toHaveLength(78);
    const major = cards.filter((c) => c.suit === "Major Arcana");
    expect(major).toHaveLength(22);
  });
});

describe("deck creation", () => {
  it("creates a standard 52 deck", () => {
    const result = deck(
      state,
      { deck: "test", operation: "create", template: "standard52" },
      rng,
    );
    expect(result.remaining).toBe(52);
    expect(state.decks["test"]).toBeDefined();
  });

  it("creates a tarot deck", () => {
    const result = deck(
      state,
      { deck: "tarot", operation: "create", template: "tarot" },
      rng,
    );
    expect(result.remaining).toBe(78);
  });

  it("creates a custom deck", () => {
    const result = deck(
      state,
      {
        deck: "custom",
        operation: "create",
        template: "custom",
        customCards: [
          { value: "Success", suit: "Genesys", raw: "SUC" },
          { value: "Advantage", suit: "Genesys", raw: "ADV" },
          { value: "Failure", suit: "Genesys", raw: "FAI" },
        ],
      },
      rng,
    );
    expect(result.remaining).toBe(3);
  });

  it("rejects empty custom deck", () => {
    expect(() =>
      deck(
        state,
        { deck: "bad", operation: "create", template: "custom", customCards: [] },
        rng,
      ),
    ).toThrow("customCards");
  });
});

describe("deck operations", () => {
  beforeEach(() => {
    deck(state, { deck: "test", operation: "create", template: "standard52" }, seededRng(42));
  });

  it("draws from top", () => {
    const result = deck(
      state,
      { deck: "test", operation: "draw", count: 1, from: "top" },
      rng,
    );
    expect(result.cards).toHaveLength(1);
    expect(result.remaining).toBe(51);
  });

  it("draws multiple cards", () => {
    const result = deck(
      state,
      { deck: "test", operation: "draw", count: 5, from: "top" },
      rng,
    );
    expect(result.cards).toHaveLength(5);
    expect(result.remaining).toBe(47);
  });

  it("draws from bottom", () => {
    const bottomCard = state.decks["test"].drawPile[state.decks["test"].drawPile.length - 1];
    const result = deck(
      state,
      { deck: "test", operation: "draw", count: 1, from: "bottom" },
      rng,
    );
    expect(result.cards![0].raw).toBe(bottomCard.raw);
  });

  it("draws random card", () => {
    const result = deck(
      state,
      { deck: "test", operation: "draw", count: 1, from: "random" },
      rng,
    );
    expect(result.cards).toHaveLength(1);
    expect(result.remaining).toBe(51);
  });

  it("rejects drawing more than remaining", () => {
    expect(() =>
      deck(state, { deck: "test", operation: "draw", count: 53, from: "top" }, rng),
    ).toThrow("Cannot draw 53");
  });

  it("peeks without removing", () => {
    const result = deck(
      state,
      { deck: "test", operation: "peek", count: 3 },
      rng,
    );
    expect(result.cards).toHaveLength(3);
    expect(result.remaining).toBe(52); // unchanged
  });

  it("shuffles and folds in discard", () => {
    // Draw some cards
    deck(state, { deck: "test", operation: "draw", count: 10, from: "top" }, rng);
    expect(state.decks["test"].drawPile).toHaveLength(42);

    const result = deck(
      state,
      { deck: "test", operation: "shuffle" },
      seededRng(99),
    );
    expect(result.remaining).toBe(42); // same count, just reshuffled
  });

  it("reports full state", () => {
    deck(state, { deck: "test", operation: "draw", count: 2, from: "top" }, rng);
    const result = deck(state, { deck: "test", operation: "state" }, rng);
    expect(result.deck).toBeDefined();
    expect(result.deck!.id).toBe("test");
    expect(result.deck!.drawPile).toHaveLength(50);
  });
});

describe("deck errors", () => {
  it("rejects operations on nonexistent deck", () => {
    expect(() =>
      deck(state, { deck: "nope", operation: "draw", count: 1 }, rng),
    ).toThrow("Deck not found");
  });
});

describe("seeded shuffle determinism", () => {
  it("produces the same order with the same seed", () => {
    deck(state, { deck: "d1", operation: "create", template: "standard52" }, seededRng(42));
    deck(state, { deck: "d2", operation: "create", template: "standard52" }, seededRng(42));

    const s1 = state.decks["d1"].drawPile.map((c) => c.raw);
    const s2 = state.decks["d2"].drawPile.map((c) => c.raw);
    expect(s1).toEqual(s2);
  });

  it("produces different order with different seeds", () => {
    deck(state, { deck: "d1", operation: "create", template: "standard52" }, seededRng(42));
    deck(state, { deck: "d2", operation: "create", template: "standard52" }, seededRng(99));

    const s1 = state.decks["d1"].drawPile.map((c) => c.raw);
    const s2 = state.decks["d2"].drawPile.map((c) => c.raw);
    expect(s1).not.toEqual(s2);
  });
});
