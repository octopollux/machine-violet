/**
 * Contract test: validates that STATE_FILES from the main codebase
 * matches the paths the Campaign Explorer expects.
 *
 * If this test breaks, the explorer's file categorization needs updating.
 */
import { describe, it, expect } from "vitest";
import { STATE_FILES } from "../../../../packages/engine/src/context/state-persistence.js";

describe("STATE_FILES contract", () => {
  it("exports the expected state file paths", () => {
    expect(STATE_FILES).toEqual({
      combat: "state/combat.json",
      clocks: "state/clocks.json",
      maps: "state/maps.json",
      decks: "state/decks.json",
      objectives: "state/objectives.json",
      scene: "state/scene.json",
      conversation: "state/conversation.json",
      ui: "state/ui.json",
      usage: "state/usage.json",
      resources: "state/resources.json",
      displayLog: "state/display-log.md",
    });
  });

  it("all state files are under state/ directory", () => {
    for (const path of Object.values(STATE_FILES)) {
      expect(path).toMatch(/^state\//);
    }
  });
});
