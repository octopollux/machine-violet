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

    it("injects separator before first DM chunk after player line", () => {
      const h = makeHarness();
      // Simulate what the client does: player line followed by empty dm (optimistic insert)
      h.state.narrativeLines = [
        { kind: "separator", text: "---" },
        { kind: "player", text: "[Wilson] I open the door" },
        { kind: "dm", text: "" },
      ];

      h.dispatch({ type: "narrative:chunk", data: { text: "The door creaks open.", kind: "dm" } });

      // Should have: separator, player, dm(""), separator, dm("The door creaks open.")
      const kinds = h.state.narrativeLines.map((l) => l.kind);
      expect(kinds).toEqual(["separator", "player", "dm", "separator", "dm"]);
      expect(h.state.narrativeLines[4].text).toBe("The door creaks open.");
    });

    it("does not inject duplicate separator on subsequent DM chunks", () => {
      const h = makeHarness();
      h.state.narrativeLines = [
        { kind: "separator", text: "---" },
        { kind: "player", text: "[Wilson] I open the door" },
        { kind: "dm", text: "" },
      ];

      h.dispatch({ type: "narrative:chunk", data: { text: "The door ", kind: "dm" } });
      h.dispatch({ type: "narrative:chunk", data: { text: "creaks open.", kind: "dm" } });

      // Only one DM separator should be present
      const separators = h.state.narrativeLines.filter((l) => l.kind === "separator");
      expect(separators).toHaveLength(2); // one before player, one before DM
    });

    it("injects separator even when dev/system lines appear after player line", () => {
      const h = makeHarness();
      h.state.narrativeLines = [
        { kind: "separator", text: "---" },
        { kind: "player", text: "[Wilson] I attack" },
        { kind: "dev", text: "[dev] tool: roll_dice" },
        { kind: "dm", text: "" },
      ];

      h.dispatch({ type: "narrative:chunk", data: { text: "You swing your sword.", kind: "dm" } });

      const kinds = h.state.narrativeLines.map((l) => l.kind);
      expect(kinds).toContain("separator");
      // Should have two separators: one before player, one before DM
      expect(kinds.filter((k) => k === "separator")).toHaveLength(2);
    });

    it("does not inject separator for opening DM narration (no player line)", () => {
      const h = makeHarness();
      // Fresh game — no player line yet
      h.dispatch({ type: "narrative:chunk", data: { text: "Welcome to the adventure.", kind: "dm" } });

      const kinds = h.state.narrativeLines.map((l) => l.kind);
      expect(kinds).toEqual(["dm"]);
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
    it("accumulates tool glyphs on start (persists after end)", () => {
      const h = makeHarness();
      h.dispatch({ type: "activity:update", data: { toolStarted: "roll_dice" } });
      expect(h.state.toolGlyphs).toEqual([{ glyph: "⚄", color: "yellow" }]);

      h.dispatch({ type: "activity:update", data: { toolEnded: "roll_dice" } });
      // Glyphs persist — they accumulate for the whole turn
      expect(h.state.toolGlyphs).toEqual([{ glyph: "⚄", color: "yellow" }]);
    });

    it("clears tool glyphs when dm_thinking starts from idle", () => {
      const h = makeHarness();
      h.dispatch({ type: "activity:update", data: { toolStarted: "roll_dice" } });
      expect(h.state.toolGlyphs.length).toBe(1);

      // Simulate end of turn (idle), then new DM turn
      h.dispatch({ type: "activity:update", data: { engineState: "waiting_input" } });
      h.dispatch({ type: "activity:update", data: { engineState: "dm_thinking" } });
      expect(h.state.toolGlyphs).toEqual([]);
    });

    it("preserves tool glyphs on tool_running → dm_thinking within a turn", () => {
      const h = makeHarness();
      // DM starts thinking
      h.dispatch({ type: "activity:update", data: { engineState: "dm_thinking" } });
      // Tool runs
      h.dispatch({ type: "activity:update", data: { toolStarted: "roll_dice" } });
      h.dispatch({ type: "activity:update", data: { engineState: "tool_running" } });
      expect(h.state.toolGlyphs.length).toBe(1);

      // DM resumes thinking after tool — glyphs should persist
      h.dispatch({ type: "activity:update", data: { engineState: "dm_thinking" } });
      expect(h.state.toolGlyphs.length).toBe(1);
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

    // Issue #431: snapshots that include narrativeLines act as authoritative
    // resets — the server uses this on retry rollback to discard a partial
    // DM stream that's about to be re-issued, and on connect to give
    // reconnecting clients the prior history.
    it("REPLACES narrativeLines when snapshot includes them", () => {
      const h = makeHarness();
      // Accumulate some chunks (simulating the partial bug-causing stream)
      h.dispatch({ type: "narrative:chunk", data: { text: "The bell ", kind: "dm" } });
      h.dispatch({ type: "narrative:chunk", data: { text: "chimes. Mol", kind: "dm" } });
      expect(h.state.narrativeLines.length).toBeGreaterThan(0);

      // Server publishes a corrective snapshot — committed transcript only.
      h.dispatch({
        type: "state:snapshot",
        data: {
          campaignId: "c1", campaignName: "Test", players: [],
          activePlayerIndex: 0, displayResources: {}, resourceValues: {},
          modelines: {}, mode: "play",
          narrativeLines: [
            { kind: "player", text: "[Aldric] open the door" },
          ],
        },
      });

      expect(h.state.narrativeLines).toEqual([
        { kind: "player", text: "[Aldric] open the door" },
      ]);
    });

    // Per-turn snapshots omit narrativeLines specifically so they don't
    // clobber in-flight stream deltas. Client must coalesce to existing
    // state in that case.
    it("PRESERVES narrativeLines when snapshot omits them", () => {
      const h = makeHarness();
      h.dispatch({ type: "narrative:chunk", data: { text: "Hello world", kind: "dm" } });
      const before = h.state.narrativeLines;

      h.dispatch({
        type: "state:snapshot",
        data: {
          campaignId: "c1", campaignName: "Test", players: [],
          activePlayerIndex: 0, displayResources: {}, resourceValues: {},
          modelines: {}, mode: "play",
          // No narrativeLines field
        },
      });

      expect(h.state.narrativeLines).toEqual(before);
    });

    // Server only sends dm/player kinds. Turn separators must be re-derived
    // client-side so the post-replace rendering matches what live streaming
    // would produce — otherwise a rolled-back retry would visibly drop the
    // turn-boundary divider that was rendered before the failure.
    it("re-derives turn separators between player and dm transitions", () => {
      const h = makeHarness();
      h.dispatch({
        type: "state:snapshot",
        data: {
          campaignId: "c1", campaignName: "Test", players: [],
          activePlayerIndex: 0, displayResources: {}, resourceValues: {},
          modelines: {}, mode: "play",
          narrativeLines: [
            { kind: "dm", text: "Opening narration." },
            { kind: "player", text: "[Aldric] open the door" },
            { kind: "dm", text: "The door swings open." },
            { kind: "dm", text: "" },
            { kind: "dm", text: "A bell chimes." },
          ],
        },
      });

      // Separator inserted only at the player→dm boundary, not before the
      // very first dm line and not between consecutive dm lines.
      expect(h.state.narrativeLines).toEqual([
        { kind: "dm", text: "Opening narration." },
        { kind: "player", text: "[Aldric] open the door" },
        { kind: "separator", text: "---" },
        { kind: "dm", text: "The door swings open." },
        { kind: "dm", text: "" },
        { kind: "dm", text: "A bell chimes." },
      ]);
    });

    it("treats empty narrativeLines as 'replace with empty' (not omitted)", () => {
      const h = makeHarness();
      h.dispatch({ type: "narrative:chunk", data: { text: "stale", kind: "dm" } });
      expect(h.state.narrativeLines.length).toBeGreaterThan(0);

      h.dispatch({
        type: "state:snapshot",
        data: {
          campaignId: "c1", campaignName: "Test", players: [],
          activePlayerIndex: 0, displayResources: {}, resourceValues: {},
          modelines: {}, mode: "play",
          narrativeLines: [],
        },
      });

      expect(h.state.narrativeLines).toEqual([]);
    });
  });

  describe("set_display_resources", () => {
    it("stores per-character resource keys from TUI command", () => {
      const h = makeHarness();
      h.dispatch({
        type: "activity:update",
        data: { engineState: "tui:set_display_resources", character: "Aldric", resources: ["HP", "Spell Slots"] },
      });
      expect(h.state.displayResources).toEqual({ Aldric: ["HP", "Spell Slots"] });
    });

    it("merges resources for multiple characters", () => {
      const h = makeHarness();
      h.dispatch({
        type: "activity:update",
        data: { engineState: "tui:set_display_resources", character: "Aldric", resources: ["HP"] },
      });
      h.dispatch({
        type: "activity:update",
        data: { engineState: "tui:set_display_resources", character: "Rook", resources: ["HP", "Ki"] },
      });
      expect(h.state.displayResources).toEqual({ Aldric: ["HP"], Rook: ["HP", "Ki"] });
    });
  });

  describe("set_resource_values", () => {
    it("stores per-character resource values from TUI command", () => {
      const h = makeHarness();
      h.dispatch({
        type: "activity:update",
        data: { engineState: "tui:set_resource_values", character: "Aldric", values: { HP: "24/30" } },
      });
      expect(h.state.resourceValues).toEqual({ Aldric: { HP: "24/30" } });
    });

    it("merges values for same character", () => {
      const h = makeHarness();
      h.dispatch({
        type: "activity:update",
        data: { engineState: "tui:set_resource_values", character: "Aldric", values: { HP: "24/30" } },
      });
      h.dispatch({
        type: "activity:update",
        data: { engineState: "tui:set_resource_values", character: "Aldric", values: { "Spell Slots": "3/4" } },
      });
      expect(h.state.resourceValues).toEqual({ Aldric: { HP: "24/30", "Spell Slots": "3/4" } });
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
    it("stores error with status and delayMs", () => {
      const h = makeHarness();
      h.dispatch({
        type: "error",
        data: { message: "API retry (status 529)", recoverable: true, status: 529, delayMs: 2000 },
      });

      expect(h.state.lastError).toEqual({
        message: "API retry (status 529)",
        recoverable: true,
        status: 529,
        delayMs: 2000,
        attemptId: 1,
      });
    });

    it("stores non-recoverable error without status/delayMs", () => {
      const h = makeHarness();
      h.dispatch({
        type: "error",
        data: { message: "Something broke", recoverable: false },
      });

      expect(h.state.lastError).toEqual({
        message: "Something broke",
        recoverable: false,
        status: undefined,
        delayMs: undefined,
        attemptId: undefined,
      });
    });

    it("bumps attemptId on each successive recoverable retry", () => {
      const h = makeHarness();
      h.dispatch({
        type: "error",
        data: { message: "retry 1", recoverable: true, status: 529, delayMs: 12000 },
      });
      expect(h.state.lastError?.attemptId).toBe(1);

      // Same status/delay (backoff capped) — attemptId must still advance
      // so the modal resets its countdown.
      h.dispatch({
        type: "error",
        data: { message: "retry 2", recoverable: true, status: 529, delayMs: 12000 },
      });
      expect(h.state.lastError?.attemptId).toBe(2);
    });

    it("clears recoverable lastError on narrative:chunk", () => {
      const h = makeHarness();
      // Set a recoverable error (retry in progress)
      h.dispatch({
        type: "error",
        data: { message: "API retry (status 429)", recoverable: true, status: 429, delayMs: 1000 },
      });
      expect(h.state.lastError).not.toBeNull();

      // Narrative chunk arrives → retry succeeded
      h.dispatch({ type: "narrative:chunk", data: { text: "The door opens.", kind: "dm" } });
      expect(h.state.lastError).toBeNull();
    });

    it("clears recoverable lastError on choices:presented", () => {
      // Regression: a successful choice-generator subagent retry produces
      // choices:presented, not narrative:chunk. The modal must still close.
      const h = makeHarness();
      h.dispatch({
        type: "error",
        data: { message: "retry", recoverable: true, status: 529, delayMs: 4000 },
      });
      expect(h.state.lastError).not.toBeNull();

      h.dispatch({
        type: "choices:presented",
        data: { id: "x", prompt: "", choices: ["a", "b"] },
      });
      expect(h.state.lastError).toBeNull();
    });

    it("clears recoverable lastError on activity:update", () => {
      // Any progress signal proves the retry resolved — even tool-only API
      // responses produce activity updates rather than narrative.
      const h = makeHarness();
      h.dispatch({
        type: "error",
        data: { message: "retry", recoverable: true, status: 0, delayMs: 1000 },
      });
      expect(h.state.lastError).not.toBeNull();

      h.dispatch({
        type: "activity:update",
        data: { engineState: "dm_thinking" },
      });
      expect(h.state.lastError).toBeNull();
    });

    it("preserves non-recoverable lastError on narrative:chunk", () => {
      const h = makeHarness();
      h.dispatch({
        type: "error",
        data: { message: "Something broke", recoverable: false },
      });

      h.dispatch({ type: "narrative:chunk", data: { text: "Hello", kind: "dm" } });
      // Non-recoverable error should persist
      expect(h.state.lastError).not.toBeNull();
      expect(h.state.lastError!.recoverable).toBe(false);
    });
  });

  describe("post-turn snapshot self-healing", () => {
    it("snapshot overwrites incremental resource patches", () => {
      const h = makeHarness();

      // Incremental patches arrive during DM turn
      h.dispatch({
        type: "activity:update",
        data: { engineState: "tui:set_display_resources", character: "Aldric", resources: ["HP"] },
      });
      h.dispatch({
        type: "activity:update",
        data: { engineState: "tui:set_resource_values", character: "Aldric", values: { HP: "24/30" } },
      });
      expect(h.state.resourceValues).toEqual({ Aldric: { HP: "24/30" } });

      // Post-turn snapshot arrives with authoritative state
      h.dispatch({
        type: "state:snapshot",
        data: {
          campaignId: "c1", campaignName: "Test",
          players: [{ name: "Player1", character: "Aldric", type: "human", color: "#ff0000" }],
          activePlayerIndex: 0,
          displayResources: { Aldric: ["HP", "MP"] },
          resourceValues: { Aldric: { HP: "30/30", MP: "10/10" } },
          modelines: { Aldric: "Level 5 Fighter" },
          mode: "play",
        },
      });

      // Snapshot values win
      expect(h.state.displayResources).toEqual({ Aldric: ["HP", "MP"] });
      expect(h.state.resourceValues).toEqual({ Aldric: { HP: "30/30", MP: "10/10" } });
      expect(h.state.modelines).toEqual({ Aldric: "Level 5 Fighter" });
    });

    it("snapshot heals missed incremental patches", () => {
      const h = makeHarness();

      // No incremental patches received (simulating missed events)
      expect(h.state.displayResources).toEqual({});
      expect(h.state.resourceValues).toEqual({});

      // Post-turn snapshot provides full state anyway
      h.dispatch({
        type: "state:snapshot",
        data: {
          campaignId: "c1", campaignName: "Test",
          players: [{ name: "Player1", character: "Wilson", type: "human", color: "#ae28f0" }],
          activePlayerIndex: 0,
          displayResources: { Wilson: ["Fate Points", "Stress"] },
          resourceValues: { Wilson: { "Fate Points": "2/2", Stress: "0/3" } },
          modelines: {},
          mode: "play",
        },
      });

      expect(h.state.displayResources).toEqual({ Wilson: ["Fate Points", "Stress"] });
      expect(h.state.resourceValues).toEqual({ Wilson: { "Fate Points": "2/2", Stress: "0/3" } });
      expect(h.state.stateSnapshot!.players[0].color).toBe("#ae28f0");
    });
  });
});
