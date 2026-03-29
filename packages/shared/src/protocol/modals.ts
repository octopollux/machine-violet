/**
 * Typed modal definitions for server → client modal commands.
 *
 * Each modal type has a well-defined payload so frontends can render
 * purpose-built UI rather than interpreting generic data.
 */
import { Type, type Static } from "@sinclair/typebox";

export const ChoiceModal = Type.Object({
  type: Type.Literal("choice"),
  id: Type.String(),
  prompt: Type.String(),
  choices: Type.Array(Type.String()),
  descriptions: Type.Optional(Type.Array(Type.String())),
});

export const DiceRollModal = Type.Object({
  type: Type.Literal("dice-roll"),
  id: Type.String(),
  expression: Type.String(),
  rolls: Type.Array(Type.Number()),
  kept: Type.Optional(Type.Array(Type.Number())),
  total: Type.Number(),
  reason: Type.Optional(Type.String()),
});

export const CharacterSheetModal = Type.Object({
  type: Type.Literal("character-sheet"),
  id: Type.String(),
  content: Type.String(),
});

export const RecapModal = Type.Object({
  type: Type.Literal("recap"),
  id: Type.String(),
  lines: Type.Array(Type.String()),
});

export const CompendiumModal = Type.Object({
  type: Type.Literal("compendium"),
  id: Type.String(),
  /** Compendium data — typed loosely here, full type in types/compendium.ts. */
  data: Type.Unknown(),
});

export const RollbackModal = Type.Object({
  type: Type.Literal("rollback"),
  id: Type.String(),
  summary: Type.String(),
});

export const NotesModal = Type.Object({
  type: Type.Literal("notes"),
  id: Type.String(),
  content: Type.String(),
});

export const CostSummaryModal = Type.Object({
  type: Type.Literal("cost-summary"),
  id: Type.String(),
  /** Token breakdown — typed loosely here, full type in types/engine.ts. */
  breakdown: Type.Unknown(),
});

export const SwatchModal = Type.Object({
  type: Type.Literal("swatch"),
  id: Type.String(),
});

export const Modal = Type.Union([
  ChoiceModal,
  DiceRollModal,
  CharacterSheetModal,
  RecapModal,
  CompendiumModal,
  RollbackModal,
  NotesModal,
  CostSummaryModal,
  SwatchModal,
]);

export type ChoiceModal = Static<typeof ChoiceModal>;
export type DiceRollModal = Static<typeof DiceRollModal>;
export type CharacterSheetModal = Static<typeof CharacterSheetModal>;
export type RecapModal = Static<typeof RecapModal>;
export type CompendiumModal = Static<typeof CompendiumModal>;
export type RollbackModal = Static<typeof RollbackModal>;
export type NotesModal = Static<typeof NotesModal>;
export type CostSummaryModal = Static<typeof CostSummaryModal>;
export type SwatchModal = Static<typeof SwatchModal>;
export type Modal = Static<typeof Modal>;
