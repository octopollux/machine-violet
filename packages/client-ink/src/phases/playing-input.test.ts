import { describe, it, expect } from "vitest";
import { routePlayingPhaseKey } from "./playing-input.js";
import type { PlayingInputKey, PlayingInputState } from "./playing-input.js";

const NO_KEY: PlayingInputKey = { escape: false, tab: false, pageUp: false, pageDown: false };
function key(over: Partial<PlayingInputKey>): PlayingInputKey {
  return { ...NO_KEY, ...over };
}

const BASE: PlayingInputState = {
  tripleEscReady: false,
  apiErrorModalActive: false,
  hasRetryOverlay: false,
  activeModal: false,
  menuOpen: false,
  activeChoices: false,
  characterPaneOpen: false,
  mode: "play",
};
function state(over: Partial<PlayingInputState>): PlayingInputState {
  return { ...BASE, ...over };
}

describe("routePlayingPhaseKey", () => {
  // The #541 regression guard: Tab must reach the quick view even while a
  // choice overlay is up. This is purely a matter of branch order — Tab is
  // routed before the "choices swallow everything" guard.
  describe("Tab over a choice overlay (#541)", () => {
    it("toggles the quick-view pane when choices are active", () => {
      expect(routePlayingPhaseKey(key({ tab: true }), state({ activeChoices: true })))
        .toBe("toggleCharacterPane");
    });

    it("still toggles the pane when no choices are active", () => {
      expect(routePlayingPhaseKey(key({ tab: true }), state({})))
        .toBe("toggleCharacterPane");
    });

    it("proves the choices guard is real: a non-Tab key is swallowed while choices are up", () => {
      // If Tab weren't routed *before* this guard, it would land here too.
      expect(routePlayingPhaseKey(key({ pageDown: true }), state({ activeChoices: true })))
        .toBe("choicesBlocked");
    });

    it("a blocking modal/menu still swallows Tab (pane is intentionally unreachable then)", () => {
      expect(routePlayingPhaseKey(key({ tab: true }), state({ activeModal: true }))).toBe("blocked");
      expect(routePlayingPhaseKey(key({ tab: true }), state({ menuOpen: true }))).toBe("blocked");
      expect(routePlayingPhaseKey(key({ tab: true }), state({ apiErrorModalActive: true }))).toBe("blocked");
    });
  });

  describe("precedence ladder", () => {
    it("triple-Esc reset wins over every other overlay", () => {
      expect(
        routePlayingPhaseKey(key({ escape: true }), state({ tripleEscReady: true, activeModal: true, menuOpen: true })),
      ).toBe("tripleEscReset");
    });

    it("Esc dismisses the API-error modal while the engine retries", () => {
      expect(
        routePlayingPhaseKey(key({ escape: true }), state({ apiErrorModalActive: true, hasRetryOverlay: true })),
      ).toBe("dismissApiError");
    });

    it("a non-Esc key is blocked while the API-error modal is up", () => {
      expect(
        routePlayingPhaseKey(key({ tab: true }), state({ apiErrorModalActive: true, hasRetryOverlay: true })),
      ).toBe("blocked");
    });

    it("Esc over choices opens the menu without clearing them", () => {
      expect(routePlayingPhaseKey(key({ escape: true }), state({ activeChoices: true })))
        .toBe("openMenuOverChoices");
    });

    it("Esc exits OOC and Dev mode", () => {
      expect(routePlayingPhaseKey(key({ escape: true }), state({ mode: "ooc" }))).toBe("exitMode");
      expect(routePlayingPhaseKey(key({ escape: true }), state({ mode: "dev" }))).toBe("exitMode");
    });

    it("Esc dismisses the character pane before falling through to the menu", () => {
      expect(routePlayingPhaseKey(key({ escape: true }), state({ characterPaneOpen: true })))
        .toBe("dismissCharacterPane");
      expect(routePlayingPhaseKey(key({ escape: true }), state({})))
        .toBe("openMenu");
    });

    it("scroll keys scroll; unrelated keys are inert", () => {
      expect(routePlayingPhaseKey(key({ pageUp: true }), state({}))).toBe("scroll");
      expect(routePlayingPhaseKey(key({ pageDown: true }), state({}))).toBe("scroll");
      expect(routePlayingPhaseKey(NO_KEY, state({}))).toBe("none");
    });
  });
});
