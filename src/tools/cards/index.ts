import type { Card, DeckInput, DeckOutput, DeckState, DecksState } from "../../types/cards.js";
import type { RNG } from "../dice/rng.js";
import { cryptoRng } from "../dice/rng.js";
import { createStandard52, createTarot } from "./templates.js";

export { createStandard52, createTarot } from "./templates.js";

/** Create a fresh decks state container */
export function createDecksState(): DecksState {
  return { decks: {} };
}

/**
 * The deck tool. Manages stateful card decks.
 */
export function deck(
  state: DecksState,
  input: DeckInput,
  rng: RNG = cryptoRng,
): DeckOutput {
  switch (input.operation) {
    case "create":
      return createDeck(state, input, rng);
    case "shuffle":
      return shuffleDeck(state, input, rng);
    case "draw":
      return drawCards(state, input, rng);
    case "return":
      return returnCards(state, input);
    case "peek":
      return peekCards(state, input);
    case "state":
      return getDeckState(state, input);
  }
}

function createDeck(state: DecksState, input: DeckInput, rng: RNG): DeckOutput {
  let cards: Card[];
  const template = input.template ?? "standard52";

  switch (template) {
    case "standard52":
      cards = createStandard52();
      break;
    case "tarot":
      cards = createTarot();
      break;
    case "custom":
      if (!input.customCards || input.customCards.length === 0) {
        throw new Error("Custom deck requires customCards");
      }
      cards = [...input.customCards];
      break;
    default:
      throw new Error(`Unknown deck template: ${template}`);
  }

  // Shuffle on creation
  fisherYatesShuffle(cards, rng);

  const deckState: DeckState = {
    id: input.deck,
    drawPile: cards,
    discardPile: [],
    hands: {},
    template,
  };

  state.decks[input.deck] = deckState;
  return { remaining: deckState.drawPile.length };
}

function shuffleDeck(state: DecksState, input: DeckInput, rng: RNG): DeckOutput {
  const deckState = requireDeck(state, input.deck);

  // Fold discard pile back into draw pile
  deckState.drawPile.push(...deckState.discardPile);
  deckState.discardPile = [];

  fisherYatesShuffle(deckState.drawPile, rng);

  return { remaining: deckState.drawPile.length };
}

function drawCards(state: DecksState, input: DeckInput, rng: RNG): DeckOutput {
  const deckState = requireDeck(state, input.deck);
  const count = input.count ?? 1;
  const from = input.from ?? "top";

  if (count > deckState.drawPile.length) {
    throw new Error(
      `Cannot draw ${count} cards, only ${deckState.drawPile.length} remaining`,
    );
  }

  const drawn: Card[] = [];

  for (let i = 0; i < count; i++) {
    let card: Card;
    switch (from) {
      case "top":
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- count guard above
        card = deckState.drawPile.shift()!;
        break;
      case "bottom":
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- count guard above
        card = deckState.drawPile.pop()!;
        break;
      case "random": {
        const idx = rng.int(0, deckState.drawPile.length - 1);
        card = deckState.drawPile.splice(idx, 1)[0];
        break;
      }
    }
    drawn.push(card);
  }

  return { cards: drawn, remaining: deckState.drawPile.length };
}

function returnCards(state: DecksState, input: DeckInput): DeckOutput {
  const deckState = requireDeck(state, input.deck);

  if (!input.cards || input.cards.length === 0) {
    throw new Error("return operation requires cards to return");
  }

  for (const raw of input.cards) {
    // Check hands first
    let found = false;
    for (const [handId, hand] of Object.entries(deckState.hands)) {
      const idx = hand.findIndex((c) => c.raw === raw);
      if (idx !== -1) {
        deckState.discardPile.push(hand.splice(idx, 1)[0]);
        deckState.hands[handId] = hand;
        found = true;
        break;
      }
    }
    if (!found) {
      // Card might be from a draw that wasn't assigned to a hand
      const card = findCardByRaw(deckState, raw);
      if (card) {
        deckState.discardPile.push(card);
      } else {
        throw new Error(`Card not found: ${raw}`);
      }
    }
  }

  return { remaining: deckState.drawPile.length };
}

function peekCards(state: DecksState, input: DeckInput): DeckOutput {
  const deckState = requireDeck(state, input.deck);
  const count = input.count ?? 1;

  if (count > deckState.drawPile.length) {
    throw new Error(
      `Cannot peek ${count} cards, only ${deckState.drawPile.length} remaining`,
    );
  }

  const peeked = deckState.drawPile.slice(0, count);
  return { cards: peeked, remaining: deckState.drawPile.length };
}

function getDeckState(state: DecksState, input: DeckInput): DeckOutput {
  const deckState = requireDeck(state, input.deck);
  return { remaining: deckState.drawPile.length, deck: { ...deckState } };
}

function requireDeck(state: DecksState, id: string): DeckState {
  const deckState = state.decks[id];
  if (!deckState) {
    throw new Error(`Deck not found: ${id}`);
  }
  return deckState;
}

function findCardByRaw(deckState: DeckState, raw: string): Card | undefined {
  const allTemplateCards = deckState.template === "standard52"
    ? createStandard52()
    : deckState.template === "tarot"
      ? createTarot()
      : [];

  return allTemplateCards.find((c) => c.raw === raw);
}

function fisherYatesShuffle(arr: Card[], rng: RNG): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
