export interface Card {
  value: string;
  suit: string;
  raw: string; // short form, e.g. "JS" for Jack of Spades
}

export type DeckOperation =
  | "create"
  | "shuffle"
  | "draw"
  | "return"
  | "peek"
  | "state";

export interface DeckInput {
  deck: string;
  operation: DeckOperation;
  count?: number;
  from?: "top" | "random" | "bottom";
  cards?: string[]; // for "return" operation
  template?: "standard52" | "tarot" | "custom";
  customCards?: Card[];
}

export interface DeckState {
  id: string;
  drawPile: Card[];
  discardPile: Card[];
  hands: Record<string, Card[]>;
  template: string;
}

export interface DeckOutput {
  cards?: Card[];
  remaining: number;
  deck?: DeckState; // only for "state" operation
}

/** All deck state, keyed by deck ID. Passed in/out — no globals. */
export interface DecksState {
  decks: Record<string, DeckState>;
}
