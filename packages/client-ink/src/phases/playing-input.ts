/**
 * Pure keyboard routing for PlayingPhase.
 *
 * The phase's `useInput` handler is a precedence-sensitive ladder of overlay
 * rules. The fragile one is #541: Tab must toggle the quick-view character pane
 * *before* the "a choice overlay is up, swallow everything" guard, so the quick
 * view stays reachable while choices are on screen. A future reorder of that
 * ladder could silently re-break it.
 *
 * Encoding the ladder here — as a pure function of the current overlay state —
 * lets us unit-test that ordering without rendering the whole phase, which is
 * entangled with the API client, terminal graphics, and window size. The
 * component owns all side effects; this function only decides which one to run.
 * Mirrors the `createEventHandler` reducer pattern used for WebSocket events.
 */

/** A keypress reduced to the keys PlayingPhase routes on. */
export interface PlayingInputKey {
  escape: boolean;
  tab: boolean;
  pageUp: boolean;
  pageDown: boolean;
}

/** Overlay/mode state the routing ladder branches on. */
export interface PlayingInputState {
  /** True when this Esc press is the third within the panic-reset window. */
  tripleEscReady: boolean;
  apiErrorModalActive: boolean;
  hasRetryOverlay: boolean;
  activeModal: boolean;
  menuOpen: boolean;
  activeChoices: boolean;
  characterPaneOpen: boolean;
  mode: "play" | "ooc" | "dev" | "setup";
}

/** The action the handler should perform for a given keypress + state. */
export type PlayingInputAction =
  | "tripleEscReset"
  | "dismissApiError"
  | "blocked"
  | "openMenuOverChoices"
  | "toggleCharacterPane"
  | "choicesBlocked"
  | "exitMode"
  | "dismissCharacterPane"
  | "openMenu"
  | "scroll"
  | "none";

/**
 * Decide what a keypress should do, as a pure function of the current overlay
 * state. The branch order here IS the behavior — each `if` is one rung of the
 * precedence ladder, and they must stay in this sequence.
 */
export function routePlayingPhaseKey(
  key: PlayingInputKey,
  state: PlayingInputState,
): PlayingInputAction {
  // Triple-Esc panic reset wins over everything.
  if (key.escape && state.tripleEscReady) return "tripleEscReset";

  // Esc dismisses the API-error modal even while the engine retries, so the
  // user isn't trapped behind the catch-all block below.
  if (key.escape && state.apiErrorModalActive && state.hasRetryOverlay) {
    return "dismissApiError";
  }

  // Catch-all: a blocking overlay swallows the key.
  if (state.apiErrorModalActive || state.activeModal || state.menuOpen) {
    return "blocked";
  }

  // Esc while choices are visible opens the menu without clearing them.
  if (key.escape && state.activeChoices) return "openMenuOverChoices";

  // Tab toggles the quick-view pane — handled BEFORE the choices guard below
  // so the quick view stays reachable while a choice overlay is up. The overlay
  // keeps arrow/Enter for selection, so the two don't conflict (#541).
  if (key.tab) return "toggleCharacterPane";

  // Otherwise a choice overlay swallows the rest of the ladder.
  if (state.activeChoices) return "choicesBlocked";

  // In OOC/Dev mode, Esc exits the mode.
  if ((state.mode === "ooc" || state.mode === "dev") && key.escape) {
    return "exitMode";
  }

  // Esc dismisses the character pane first, then opens the menu.
  if (key.escape) {
    return state.characterPaneOpen ? "dismissCharacterPane" : "openMenu";
  }

  // Scroll keys.
  if (key.pageUp || key.pageDown) return "scroll";

  return "none";
}
