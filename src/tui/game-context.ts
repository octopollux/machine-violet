import { createContext, useContext } from "react";
import type Anthropic from "@anthropic-ai/sdk";
import type { NarrativeLine, ActiveModal, RetryOverlay } from "../types/tui.js";
import type { ResolvedTheme, StyleVariant } from "./themes/types.js";
import type { GameEngine } from "../agents/game-engine.js";
import type { GameState } from "../agents/game-state.js";
import type { TuiCommand, UsageStats } from "../agents/agent-loop.js";
import type { CostTracker } from "../context/cost-tracker.js";
import type { ModelTier } from "../config/models.js";

/** A non-DM mode session (OOC, Dev, or future modes). */
export interface ModeSession {
  send(text: string, onDelta: (delta: string) => void): Promise<{ usage: UsageStats }>;
  label: string;    // "OOC" | "Dev"
  tier: ModelTier;  // for cost tracking
}

/** Every piece of shared state that App provides to PlayingPhase. */
export interface GameContextValue {
  // Refs
  engineRef: React.RefObject<GameEngine | null>;
  gameStateRef: React.RefObject<GameState | null>;
  clientRef: React.RefObject<Anthropic | null>;
  costTracker: React.RefObject<CostTracker>;
  // Narrative
  narrativeLines: NarrativeLine[];
  setNarrativeLines: React.Dispatch<React.SetStateAction<NarrativeLine[]>>;
  // Theme
  theme: ResolvedTheme;
  variant: StyleVariant;
  setVariant: (v: StyleVariant) => void;
  setTheme: (t: ResolvedTheme) => void;
  keyColor: string;
  setKeyColor: (hex: string) => void;
  // Display
  campaignName: string;
  activePlayerIndex: number;
  setActivePlayerIndex: (i: number) => void;
  engineState: string | null;
  resources: string[];
  modelines: Record<string, string>;
  // Modal state
  activeModal: ActiveModal;
  setActiveModal: (m: ActiveModal) => void;
  choiceIndex: number;
  setChoiceIndex: React.Dispatch<React.SetStateAction<number>>;
  // Retry overlay (system-driven, separate from activeModal)
  retryOverlay: RetryOverlay | null;
  // Mode session (replaces oocActive/devActive booleans)
  activeSession: ModeSession | null;
  setActiveSession: (s: ModeSession | null) => void;
  previousVariantRef: React.MutableRefObject<StyleVariant>;
  // Dev mode
  devModeEnabled?: boolean;
  // Actions
  dispatchTuiCommand: (cmd: TuiCommand) => void;
  onShutdown: () => void;
  onEndSession: () => void;
  onRecapDismissed: () => void;
}

const GameContext = createContext<GameContextValue | null>(null);

export const GameProvider = GameContext.Provider;

export function useGameContext(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) {
    throw new Error("useGameContext must be used within a <GameProvider>");
  }
  return ctx;
}
