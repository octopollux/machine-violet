import type { Card } from "@machine-violet/shared/types/cards.js";

const SUITS = ["Hearts", "Diamonds", "Clubs", "Spades"] as const;
const SUIT_SHORT: Record<string, string> = {
  Hearts: "H",
  Diamonds: "D",
  Clubs: "C",
  Spades: "S",
};
const VALUES = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10",
  "Jack", "Queen", "King", "Ace",
];
const VALUE_SHORT: Record<string, string> = {
  "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7",
  "8": "8", "9": "9", "10": "T", Jack: "J", Queen: "Q",
  King: "K", Ace: "A",
};

export function createStandard52(): Card[] {
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      cards.push({
        value,
        suit,
        raw: `${VALUE_SHORT[value]}${SUIT_SHORT[suit]}`,
      });
    }
  }
  return cards;
}

const TAROT_MAJOR = [
  "The Fool", "The Magician", "The High Priestess", "The Empress",
  "The Emperor", "The Hierophant", "The Lovers", "The Chariot",
  "Strength", "The Hermit", "Wheel of Fortune", "Justice",
  "The Hanged Man", "Death", "Temperance", "The Devil",
  "The Tower", "The Star", "The Moon", "The Sun",
  "Judgement", "The World",
];

const TAROT_SUITS = ["Wands", "Cups", "Swords", "Pentacles"] as const;
const TAROT_VALUES = [
  "Ace", "2", "3", "4", "5", "6", "7", "8", "9", "10",
  "Page", "Knight", "Queen", "King",
];

export function createTarot(): Card[] {
  const cards: Card[] = [];

  // Major Arcana
  for (let i = 0; i < TAROT_MAJOR.length; i++) {
    cards.push({
      value: TAROT_MAJOR[i],
      suit: "Major Arcana",
      raw: `M${i.toString().padStart(2, "0")}`,
    });
  }

  // Minor Arcana
  for (const suit of TAROT_SUITS) {
    for (const value of TAROT_VALUES) {
      cards.push({
        value,
        suit,
        raw: `${value.slice(0, 2)}${suit[0]}`,
      });
    }
  }

  return cards;
}
