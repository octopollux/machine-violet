/**
 * Client-side game context — provides state and actions to all TUI components.
 *
 * Unlike the monolith's GameContext which held engine refs, this version
 * is powered by the connection layer (ApiClient + WsClient + EventHandler).
 * Components read state and dispatch actions through this context.
 */
import { createContext, useContext } from "react";
import type { NarrativeLine, ActiveModal, RetryOverlay } from "@machine-violet/shared/types/tui.js";
import type { ChoicesData, Turn, StateSnapshot } from "@machine-violet/shared";
import type { ToolGlyph } from "./activity.js";
import type { ResolvedTheme, StyleVariant } from "./themes/types.js";
import type { ApiClient } from "../api-client.js";
import type { StdinFilterChain } from "./hooks/stdinFilterChain.js";

export interface GameContextValue {
  // Connection
  apiClient: ApiClient;
  connected: boolean;

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
  toolGlyphs: ToolGlyph[];
  resources: string[];
  modelines: Record<string, string>;

  // Turns
  currentTurn: Turn | null;

  // Server-driven choices (rendered inline in Player Pane, not as modals)
  activeChoices: ChoicesData | null;
  setActiveChoices: (c: ChoicesData | null) => void;

  // Client-driven modals (character sheet, compendium, notes, swatch — opened from menu)
  activeModal: ActiveModal | null;
  setActiveModal: (m: ActiveModal | null) => void;

  // Retry overlay (system-driven, separate from activeModal)
  retryOverlay: RetryOverlay | null;

  // Session mode
  mode: "play" | "ooc" | "dev" | "setup";

  // State snapshot (latest from server)
  stateSnapshot: StateSnapshot | null;

  // Terminal capabilities
  /** Whether the Kitty keyboard protocol is active (affects raw mode guardian). */
  hasKittyProtocol?: boolean;
  /** Stdin filter chain for registering/unregistering input filters. */
  stdinFilterChain?: StdinFilterChain | null;

  // Settings
  devModeEnabled?: boolean;
  showVerbose?: boolean;

  // Actions
  onReturnToMenu: () => void;
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

/** Like useGameContext but returns null instead of throwing when outside a GameProvider. */
export function useOptionalGameContext(): GameContextValue | null {
  return useContext(GameContext);
}
