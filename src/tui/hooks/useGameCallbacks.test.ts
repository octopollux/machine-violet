import { describe, it, expect, vi } from "vitest";

/**
 * Tests for dispatchTuiCommand logic — exercises the dispatch switch
 * directly since the hook is a thin useCallback wrapper.
 */

import type { TuiCommand } from "../../agents/agent-loop.js";
import type { StyleVariant } from "../../types/tui.js";
import type { ActiveModal } from "../../app.js";

/** Simulates the dispatch logic from useGameCallbacks */
function createDispatch(deps: {
  setModelineOverride: ReturnType<typeof vi.fn>;
  setVariant: ReturnType<typeof vi.fn>;
  setStyle: ReturnType<typeof vi.fn>;
  setResources: ReturnType<typeof vi.fn>;
  setChoiceIndex: ReturnType<typeof vi.fn>;
  setActiveModal: ReturnType<typeof vi.fn>;
  setOocActive: ReturnType<typeof vi.fn>;
  setNarrativeLines: ReturnType<typeof vi.fn>;
  variantRef: { current: StyleVariant };
  previousVariantRef: { current: StyleVariant };
  gameStateRef: { current: unknown };
  fileIO: { current: { readFile: ReturnType<typeof vi.fn> } };
}) {
  return (cmd: TuiCommand) => {
    switch (cmd.type) {
      case "update_modeline":
        deps.setModelineOverride(cmd.text as string);
        break;
      case "set_display_resources":
        deps.setResources(cmd.resources as string[]);
        break;
      case "present_choices": {
        const choices = cmd.choices as string[];
        if (choices && choices.length > 0) {
          deps.setChoiceIndex(0);
          deps.setActiveModal({ kind: "choice", prompt: (cmd.prompt as string) || "What do you do?", choices });
        }
        break;
      }
      case "present_roll":
        deps.setActiveModal({
          kind: "dice",
          expression: cmd.expression as string,
          rolls: cmd.rolls as number[],
          kept: cmd.kept as number[] | undefined,
          total: cmd.total as number,
          reason: cmd.reason as string | undefined,
        });
        break;
      case "enter_ooc":
        deps.previousVariantRef.current = deps.variantRef.current;
        deps.setOocActive(true);
        deps.setVariant("ooc");
        deps.setNarrativeLines(vi.fn());
        break;
    }
  };
}

function makeDeps() {
  return {
    setModelineOverride: vi.fn(),
    setVariant: vi.fn(),
    setStyle: vi.fn(),
    setResources: vi.fn(),
    setChoiceIndex: vi.fn(),
    setActiveModal: vi.fn() as ReturnType<typeof vi.fn> & ((m: ActiveModal) => void),
    setOocActive: vi.fn(),
    setNarrativeLines: vi.fn(),
    variantRef: { current: "exploration" as StyleVariant },
    previousVariantRef: { current: "exploration" as StyleVariant },
    gameStateRef: { current: null },
    fileIO: { current: { readFile: vi.fn() } },
  };
}

describe("dispatchTuiCommand logic", () => {
  it("handles update_modeline", () => {
    const deps = makeDeps();
    const dispatch = createDispatch(deps);
    dispatch({ type: "update_modeline", text: "hello" });
    expect(deps.setModelineOverride).toHaveBeenCalledWith("hello");
  });

  it("handles set_display_resources", () => {
    const deps = makeDeps();
    const dispatch = createDispatch(deps);
    dispatch({ type: "set_display_resources", resources: ["HP: 10"] });
    expect(deps.setResources).toHaveBeenCalledWith(["HP: 10"]);
  });

  it("handles present_choices", () => {
    const deps = makeDeps();
    const dispatch = createDispatch(deps);
    dispatch({ type: "present_choices", prompt: "Choose:", choices: ["A", "B"] });
    expect(deps.setChoiceIndex).toHaveBeenCalledWith(0);
    expect(deps.setActiveModal).toHaveBeenCalledWith({
      kind: "choice", prompt: "Choose:", choices: ["A", "B"],
    });
  });

  it("ignores present_choices with empty array", () => {
    const deps = makeDeps();
    const dispatch = createDispatch(deps);
    dispatch({ type: "present_choices", prompt: "Choose:", choices: [] });
    expect(deps.setActiveModal).not.toHaveBeenCalled();
  });

  it("handles present_roll", () => {
    const deps = makeDeps();
    const dispatch = createDispatch(deps);
    dispatch({ type: "present_roll", expression: "2d6", rolls: [3, 4], total: 7 } as TuiCommand);
    expect(deps.setActiveModal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "dice", expression: "2d6", total: 7 }),
    );
  });

  it("handles enter_ooc — saves previous variant", () => {
    const deps = makeDeps();
    deps.variantRef.current = "combat";
    const dispatch = createDispatch(deps);
    dispatch({ type: "enter_ooc" });
    expect(deps.previousVariantRef.current).toBe("combat");
    expect(deps.setOocActive).toHaveBeenCalledWith(true);
    expect(deps.setVariant).toHaveBeenCalledWith("ooc");
  });
});

/**
 * Simulates the onNarrativeDelta logic from useGameCallbacks.
 * Mirrors the setNarrativeLines updater function.
 */
function applyDelta(prev: string[], delta: string): string[] {
  const lines = [...prev];
  if (lines.length === 0) lines.push(delta);
  else if (lines[lines.length - 1] === "" && delta !== "") lines.push(delta);
  else lines[lines.length - 1] += delta;
  const last = lines[lines.length - 1];
  if (last.includes("\n")) {
    const parts = last.split("\n");
    lines[lines.length - 1] = parts[0];
    for (let i = 1; i < parts.length; i++) {
      lines.push(parts[i]);
    }
  }
  return lines;
}

describe("onNarrativeDelta logic", () => {
  it("preserves blank line separator when DM delta arrives", () => {
    // Player input leaves trailing blank line
    const after_player = ["", "> Player: Attack!", ""];
    // First DM delta should NOT overwrite the blank separator
    const result = applyDelta(after_player, "The dragon");
    expect(result).toEqual(["", "> Player: Attack!", "", "The dragon"]);
  });

  it("appends subsequent deltas to the current line", () => {
    const lines = ["", "> Player: Attack!", "", "The dragon"];
    const result = applyDelta(lines, " roars!");
    expect(result).toEqual(["", "> Player: Attack!", "", "The dragon roars!"]);
  });

  it("splits on newlines within a delta", () => {
    const lines = ["", "> Player: Attack!", "", "First line"];
    const result = applyDelta(lines, ".\nSecond line");
    expect(result).toEqual(["", "> Player: Attack!", "", "First line.", "Second line"]);
  });

  it("pushes to empty array", () => {
    expect(applyDelta([], "Hello")).toEqual(["Hello"]);
  });
});
