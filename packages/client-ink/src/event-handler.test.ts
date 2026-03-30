import { describe, it, expect } from "vitest";
import {
  createEventHandler,
  initialClientState,
  type StateUpdater,
} from "./event-handler.js";
import type { ServerEvent } from "@machine-violet/shared";

function makeHarness() {
  let state = initialClientState();
  const update: StateUpdater = (fn) => {
    state = fn(state);
  };
  const handler = createEventHandler(update);
  return {
    dispatch: (event: ServerEvent) => handler(event),
    get state() { return state; },
  };
}

describe("event-handler", () => {
  describe("narrative events", () => {
    it("accumulates narrative:chunk text", () => {
      const h = makeHarness();
      h.dispatch({ type: "narrative:chunk", data: { text: "Hello ", kind: "dm" } });
      h.dispatch({ type: "narrative:chunk", data: { text: "world", kind: "dm" } });

      expect(h.state.narrativeLines).toHaveLength(1);
      expect(h.state.narrativeLines[0]).toEqual({ kind: "dm", text: "Hello world" });
    });

    it("adds spacer on narrative:complete", () => {
      const h = makeHarness();
      h.dispatch({ type: "narrative:chunk", data: { text: "Done.", kind: "dm" } });
      h.dispatch({ type: "narrative:complete", data: { text: "Done." } });

      expect(h.state.narrativeLines).toHaveLength(2);
      expect(h.state.narrativeLines[1].kind).toBe("spacer");
    });
  });

  describe("turn lifecycle", () => {
    it("sets currentTurn on turn:opened", () => {
      const h = makeHarness();
      h.dispatch({
        type: "turn:opened",
        data: {
          id: "t1", seq: 1, campaignId: "test", status: "open",
          activePlayers: ["aldric"], aiPlayers: [], contributions: [], commitPolicy: "auto",
        },
      });

      expect(h.state.currentTurn).not.toBeNull();
      expect(h.state.currentTurn!.id).toBe("t1");
    });

    it("shows player contributions as narrative", () => {
      const h = makeHarness();
      h.dispatch({
        type: "turn:updated",
        data: {
          turnId: "t1",
          contribution: { id: "c1", playerId: "sable", source: "client", text: "I help!", amendment: false },
        },
      });

      expect(h.state.narrativeLines).toHaveLength(1);
      expect(h.state.narrativeLines[0].text).toContain("sable");
      expect(h.state.narrativeLines[0].text).toContain("I help!");
    });

    it("clears currentTurn on turn:resolved", () => {
      const h = makeHarness();
      h.dispatch({
        type: "turn:opened",
        data: {
          id: "t1", seq: 1, campaignId: "test", status: "open",
          activePlayers: ["aldric"], aiPlayers: [], contributions: [], commitPolicy: "auto",
        },
      });
      h.dispatch({ type: "turn:resolved", data: { turnId: "t1" } });

      expect(h.state.currentTurn).toBeNull();
    });

    it("sets sessionStale on campaign mismatch", () => {
      const h = makeHarness();
      h.dispatch({
        type: "turn:opened",
        data: {
          id: "t1", seq: 1, campaignId: "campaign-a", status: "open",
          activePlayers: ["aldric"], aiPlayers: [], contributions: [], commitPolicy: "auto",
        },
      });
      h.dispatch({
        type: "turn:opened",
        data: {
          id: "t2", seq: 1, campaignId: "campaign-b", status: "open",
          activePlayers: ["aldric"], aiPlayers: [], contributions: [], commitPolicy: "auto",
        },
      });

      expect(h.state.sessionStale).toBe(true);
    });

    it("silently accepts seq gaps (missed turns)", () => {
      const h = makeHarness();
      h.dispatch({
        type: "turn:opened",
        data: {
          id: "t1", seq: 1, campaignId: "test", status: "open",
          activePlayers: ["aldric"], aiPlayers: [], contributions: [], commitPolicy: "auto",
        },
      });
      h.dispatch({
        type: "turn:opened",
        data: {
          id: "t5", seq: 5, campaignId: "test", status: "open",
          activePlayers: ["aldric"], aiPlayers: [], contributions: [], commitPolicy: "auto",
        },
      });

      expect(h.state.sessionStale).toBe(false);
      expect(h.state.currentTurn!.seq).toBe(5);
      expect(h.state.lastError).toBeNull();
    });
  });

  describe("choices", () => {
    it("sets activeChoices on choices:presented", () => {
      const h = makeHarness();
      h.dispatch({
        type: "choices:presented",
        data: { id: "c1", prompt: "Pick one", choices: ["A", "B"] },
      });

      expect(h.state.activeChoices).not.toBeNull();
      expect(h.state.activeChoices!.prompt).toBe("Pick one");
    });

    it("clears activeChoices on choices:cleared", () => {
      const h = makeHarness();
      h.dispatch({
        type: "choices:presented",
        data: { id: "c1", prompt: "Pick", choices: ["A"] },
      });
      h.dispatch({ type: "choices:cleared", data: {} });

      expect(h.state.activeChoices).toBeNull();
    });
  });

  describe("activity", () => {
    it("tracks active tools", () => {
      const h = makeHarness();
      h.dispatch({ type: "activity:update", data: { toolStarted: "roll_dice" } });
      expect(h.state.activeTools).toEqual(["roll_dice"]);

      h.dispatch({ type: "activity:update", data: { toolEnded: "roll_dice" } });
      expect(h.state.activeTools).toEqual([]);
    });

    it("updates engine state", () => {
      const h = makeHarness();
      h.dispatch({ type: "activity:update", data: { engineState: "dm_thinking" } });
      expect(h.state.engineState).toBe("dm_thinking");
    });
  });

  describe("state snapshot", () => {
    it("stores snapshot and updates mode", () => {
      const h = makeHarness();
      h.dispatch({
        type: "state:snapshot",
        data: {
          campaignId: "c1", campaignName: "Test", players: [],
          activePlayerIndex: 0, displayResources: {}, resourceValues: {},
          modelines: {}, mode: "play",
        },
      });

      expect(h.state.stateSnapshot).not.toBeNull();
      expect(h.state.stateSnapshot!.campaignId).toBe("c1");
    });
  });

  describe("session mode", () => {
    it("updates mode and variant", () => {
      const h = makeHarness();
      h.dispatch({ type: "session:mode", data: { mode: "ooc", variant: "ooc" } });

      expect(h.state.mode).toBe("ooc");
      expect(h.state.variant).toBe("ooc");
    });
  });

  describe("session ended", () => {
    it("marks session as ended", () => {
      const h = makeHarness();
      h.dispatch({ type: "session:ended", data: {} });

      expect(h.state.sessionEnded).toBe(true);
      expect(h.state.currentTurn).toBeNull();
    });
  });

  describe("errors", () => {
    it("stores error", () => {
      const h = makeHarness();
      h.dispatch({
        type: "error",
        data: { message: "API retry", recoverable: true, status: 529, delayMs: 5000 },
      });

      expect(h.state.lastError).toEqual({ message: "API retry", recoverable: true });
    });
  });
});
