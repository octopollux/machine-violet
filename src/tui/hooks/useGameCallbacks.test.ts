import { describe, it, expect, vi } from "vitest";

/**
 * Tests for dispatchTuiCommand logic — exercises the dispatch switch
 * directly since the hook is a thin useCallback wrapper.
 */

import type { TuiCommand } from "../../agents/agent-loop.js";
import type { StyleVariant, NarrativeLine, ActiveModal } from "../../types/tui.js";
import { appendDelta } from "../narrative-helpers.js";

/** Simulates the dispatch logic from useGameCallbacks */
function createDispatch(deps: {
  setModelines: ReturnType<typeof vi.fn>;
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
      case "update_modeline": {
        const char = cmd.character as string;
        const text = cmd.text as string;
        deps.setModelines((prev: Record<string, string>) => ({ ...prev, [char]: text }));
        break;
      }
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
    setModelines: vi.fn(),
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
  it("handles update_modeline with character", () => {
    const deps = makeDeps();
    const dispatch = createDispatch(deps);
    dispatch({ type: "update_modeline", text: "HP 45/50", character: "Aldric" });
    expect(deps.setModelines).toHaveBeenCalledWith(expect.any(Function));
    const updater = deps.setModelines.mock.calls[0][0];
    expect(updater({})).toEqual({ Aldric: "HP 45/50" });
  });

  it("update_modeline merges with existing modelines", () => {
    const deps = makeDeps();
    const dispatch = createDispatch(deps);
    dispatch({ type: "update_modeline", text: "HP 45/50", character: "Aldric" });
    const updater = deps.setModelines.mock.calls[0][0];
    expect(updater({ Kira: "HP 30/30" })).toEqual({ Kira: "HP 30/30", Aldric: "HP 45/50" });
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

const dm = (text: string): NarrativeLine => ({ kind: "dm", text });
const player = (text: string): NarrativeLine => ({ kind: "player", text });

describe("appendDelta (typed NarrativeLine)", () => {
  it("preserves blank line separator when DM delta arrives", () => {
    const after_player: NarrativeLine[] = [dm(""), player("> Player: Attack!"), dm("")];
    const result = appendDelta(after_player, "The dragon", "dm");
    expect(result).toEqual([dm(""), player("> Player: Attack!"), dm(""), dm("The dragon")]);
  });

  it("appends subsequent deltas to the current line", () => {
    const lines: NarrativeLine[] = [dm(""), player("> Player: Attack!"), dm(""), dm("The dragon")];
    const result = appendDelta(lines, " roars!", "dm");
    expect(result).toEqual([dm(""), player("> Player: Attack!"), dm(""), dm("The dragon roars!")]);
  });

  it("splits on newlines within a delta (double-spaced)", () => {
    const lines: NarrativeLine[] = [dm(""), player("> Player: Attack!"), dm(""), dm("First line")];
    const result = appendDelta(lines, ".\nSecond line", "dm");
    expect(result).toEqual([dm(""), player("> Player: Attack!"), dm(""), dm("First line."), dm(""), dm("Second line")]);
  });

  it("preserves single blank line for \\n\\n (no extra doubling)", () => {
    const lines: NarrativeLine[] = [dm("First")];
    const result = appendDelta(lines, "\n\nSecond", "dm");
    expect(result).toEqual([dm("First"), dm(""), dm("Second")]);
  });

  it("pushes to empty array", () => {
    expect(appendDelta([], "Hello", "dm")).toEqual([dm("Hello")]);
  });

  it("does not concatenate dm delta onto a dev line", () => {
    const dev = (text: string): NarrativeLine => ({ kind: "dev", text });
    const lines: NarrativeLine[] = [dm("Start"), dev("[dev] file:write decks.json (100 chars)")];
    const result = appendDelta(lines, "The Nine of Wands.", "dm");
    expect(result).toEqual([
      dm("Start"),
      dev("[dev] file:write decks.json (100 chars)"),
      dm("The Nine of Wands."),
    ]);
  });
});
