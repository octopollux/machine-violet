import { describe, it, expect, vi } from "vitest";

/**
 * Tests for dispatchTuiCommand logic — exercises the dispatch switch
 * directly since the hook is a thin useCallback wrapper.
 */

import type { TuiCommand } from "../../agents/agent-loop.js";
import type { StyleVariant, NarrativeLine, ActiveModal } from "../../types/tui.js";
import type { GameState } from "../../agents/game-state.js";
import { appendDelta } from "../narrative-helpers.js";
import { formatResources } from "./useGameCallbacks.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn> & ((...args: any[]) => any);

/** Simulates the dispatch logic from useGameCallbacks */
function createDispatch(deps: {
  setModelines: MockFn;
  setVariant: MockFn;
  setResources: MockFn;
  setActiveModal: MockFn;
  setActiveSession: MockFn;
  setNarrativeLines: MockFn;
  variantRef: { current: StyleVariant };
  previousVariantRef: { current: StyleVariant };
  gameStateRef: { current: unknown };
  clientRef: { current: unknown };
  engineRef: { current: unknown };
  fileIO: { current: { readFile: MockFn } };
}) {
  return (cmd: TuiCommand) => {
    switch (cmd.type) {
      case "update_modeline": {
        const char = cmd.character as string;
        const text = cmd.text as string;
        deps.setModelines((prev: Record<string, string>) => ({ ...prev, [char]: text }));
        break;
      }
      case "set_display_resources": {
        const gs1 = deps.gameStateRef.current as GameState | null;
        if (gs1) {
          const char = cmd.character as string;
          gs1.displayResources[char] = cmd.resources as string[];
          deps.setResources(formatResources(gs1));
        }
        break;
      }
      case "set_resource_values": {
        const gs2 = deps.gameStateRef.current as GameState | null;
        if (gs2) {
          const char = cmd.character as string;
          const vals = cmd.values as Record<string, string>;
          if (!gs2.resourceValues[char]) gs2.resourceValues[char] = {};
          Object.assign(gs2.resourceValues[char], vals);
          deps.setResources(formatResources(gs2));
        }
        break;
      }
      case "present_choices": {
        const choices = cmd.choices as string[];
        if (choices && choices.length > 0) {
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
        deps.setActiveSession(expect.anything());
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
    setResources: vi.fn(),
    setActiveModal: vi.fn() as ReturnType<typeof vi.fn> & ((m: ActiveModal) => void),
    setActiveSession: vi.fn(),
    setNarrativeLines: vi.fn(),
    variantRef: { current: "exploration" as StyleVariant },
    previousVariantRef: { current: "exploration" as StyleVariant },
    gameStateRef: { current: { displayResources: {}, resourceValues: {} } },
    clientRef: { current: null },
    engineRef: { current: null },
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

  it("handles set_display_resources with formatted values", () => {
    const deps = makeDeps();
    const gs = deps.gameStateRef.current as GameState;
    gs.resourceValues["Aldric"] = { HP: "24/30" };
    const dispatch = createDispatch(deps);
    dispatch({ type: "set_display_resources", character: "Aldric", resources: ["HP", "Spell Slots"] });
    expect(deps.setResources).toHaveBeenCalledWith(["HP 24/30", "Spell Slots"]);
  });

  it("handles set_resource_values dispatch", () => {
    const deps = makeDeps();
    const gs = deps.gameStateRef.current as GameState;
    gs.displayResources["Aldric"] = ["HP", "Spell Slots"];
    const dispatch = createDispatch(deps);
    dispatch({ type: "set_resource_values", character: "Aldric", values: { HP: "24/30", "Spell Slots": "3/4" } } as TuiCommand);
    expect(deps.setResources).toHaveBeenCalledWith(["HP 24/30", "Spell Slots 3/4"]);
    expect(gs.resourceValues["Aldric"]).toEqual({ HP: "24/30", "Spell Slots": "3/4" });
  });

  it("handles present_choices", () => {
    const deps = makeDeps();
    const dispatch = createDispatch(deps);
    dispatch({ type: "present_choices", prompt: "Choose:", choices: ["A", "B"] });
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
    expect(deps.setActiveSession).toHaveBeenCalled();
    expect(deps.setVariant).toHaveBeenCalledWith("ooc");
  });
});

const dm = (text: string): NarrativeLine => ({ kind: "dm", text });
const player = (text: string): NarrativeLine => ({ kind: "player", text });
const separator = (): NarrativeLine => ({ kind: "separator", text: "" });

describe("formatResources", () => {
  it("combines keys and values into formatted strings", () => {
    const gs = {
      displayResources: { Aldric: ["HP", "Spell Slots"] },
      resourceValues: { Aldric: { HP: "24/30", "Spell Slots": "3/4" } },
    } as unknown as GameState;
    expect(formatResources(gs)).toEqual(["HP 24/30", "Spell Slots 3/4"]);
  });

  it("returns key only when no value set", () => {
    const gs = {
      displayResources: { Aldric: ["HP", "Ki"] },
      resourceValues: { Aldric: { HP: "24/30" } },
    } as unknown as GameState;
    expect(formatResources(gs)).toEqual(["HP 24/30", "Ki"]);
  });

  it("returns empty array when no display resources", () => {
    const gs = {
      displayResources: {},
      resourceValues: {},
    } as unknown as GameState;
    expect(formatResources(gs)).toEqual([]);
  });

  it("handles multiple characters", () => {
    const gs = {
      displayResources: { Aldric: ["HP"], Rook: ["HP"] },
      resourceValues: { Aldric: { HP: "24/30" }, Rook: { HP: "28/30" } },
    } as unknown as GameState;
    expect(formatResources(gs)).toEqual(["HP 24/30", "HP 28/30"]);
  });
});

describe("onTurnStart callback", () => {
  it("pushes player line for role=player", () => {
    const deps = makeDeps();
    const setNarrativeLines = deps.setNarrativeLines;

    const onTurnStart = (turn: { role: string; participant: string; text: string }) => {
      if (turn.role === "player") {
        setNarrativeLines((prev: NarrativeLine[]) => [
          ...prev,
          { kind: "player", text: `> ${turn.participant}: ${turn.text}` },
        ]);
      } else if (turn.role === "ai") {
        setNarrativeLines((prev: NarrativeLine[]) => [
          ...prev,
          { kind: "player", text: `> ${turn.participant} (AI): ${turn.text}` },
        ]);
      }
    };

    const existingLines: NarrativeLine[] = [dm("The tavern is warm."), separator()];
    onTurnStart({ role: "player", participant: "Aldric", text: "I look around." });

    const updater = setNarrativeLines.mock.calls[0][0];
    const result = updater(existingLines);
    expect(result).toEqual([
      dm("The tavern is warm."),
      separator(),
      player("> Aldric: I look around."),
    ]);
  });

  it("pushes player-kind line with (AI) suffix for role=ai", () => {
    const deps = makeDeps();
    const setNarrativeLines = deps.setNarrativeLines;

    const onTurnStart = (turn: { role: string; participant: string; text: string }) => {
      if (turn.role === "player") {
        setNarrativeLines((prev: NarrativeLine[]) => [
          ...prev,
          { kind: "player", text: `> ${turn.participant}: ${turn.text}` },
        ]);
      } else if (turn.role === "ai") {
        setNarrativeLines((prev: NarrativeLine[]) => [
          ...prev,
          { kind: "player", text: `> ${turn.participant} (AI): ${turn.text}` },
        ]);
      }
    };

    const existingLines: NarrativeLine[] = [dm("The goblin snarls."), separator()];
    onTurnStart({ role: "ai", participant: "Zara", text: "I attack the goblin!" });

    const updater = setNarrativeLines.mock.calls[0][0];
    const result = updater(existingLines);
    expect(result).toEqual([
      dm("The goblin snarls."),
      separator(),
      player("> Zara (AI): I attack the goblin!"),
    ]);
  });

  it("is a no-op for role=dm", () => {
    const deps = makeDeps();
    const setNarrativeLines = deps.setNarrativeLines;

    const onTurnStart = (turn: { role: string; participant: string; text: string }) => {
      if (turn.role === "player") {
        setNarrativeLines((prev: NarrativeLine[]) => [
          ...prev,
          { kind: "player", text: `> ${turn.participant}: ${turn.text}` },
        ]);
      } else if (turn.role === "ai") {
        setNarrativeLines((prev: NarrativeLine[]) => [
          ...prev,
          { kind: "player", text: `> ${turn.participant} (AI): ${turn.text}` },
        ]);
      }
    };

    onTurnStart({ role: "dm", participant: "DM", text: "" });

    expect(setNarrativeLines).not.toHaveBeenCalled();
  });
});

describe("onTurnEnd callback", () => {
  it("pushes separator after DM response", () => {
    const deps = makeDeps();
    const setNarrativeLines = deps.setNarrativeLines;

    const onTurnEnd = () => {
      setNarrativeLines((prev: NarrativeLine[]) => [...prev, { kind: "separator", text: "" }]);
    };

    const existingLines: NarrativeLine[] = [player("> Aldric: Hello."), dm("The tavern is warm.")];
    onTurnEnd();

    const updater = setNarrativeLines.mock.calls[0][0];
    const result = updater(existingLines);
    expect(result).toEqual([
      player("> Aldric: Hello."),
      dm("The tavern is warm."),
      separator(),
    ]);
  });
});

describe("onTurnEnd callback — all roles get separator", () => {
  it("pushes separator for player turn", () => {
    const deps = makeDeps();
    const setNarrativeLines = deps.setNarrativeLines;

    const onTurnEnd = () => {
      setNarrativeLines((prev: NarrativeLine[]) => [...prev, { kind: "separator", text: "" }]);
    };

    const existingLines: NarrativeLine[] = [player("> Aldric: Hello.")];
    onTurnEnd();

    const updater = setNarrativeLines.mock.calls[0][0];
    const result = updater(existingLines);
    expect(result).toEqual([
      player("> Aldric: Hello."),
      separator(),
    ]);
  });
});

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

  it("splits on newlines within a delta (spacer between non-empty parts)", () => {
    const spacer = (text: string): NarrativeLine => ({ kind: "spacer", text });
    const lines: NarrativeLine[] = [dm(""), player("> Player: Attack!"), dm(""), dm("First line")];
    const result = appendDelta(lines, ".\nSecond line", "dm");
    expect(result).toEqual([dm(""), player("> Player: Attack!"), dm(""), dm("First line."), spacer(""), dm("Second line")]);
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

  it("trailing \\n produces spacer, not dm blank (no false paragraph boundary)", () => {
    const spacer = (text: string): NarrativeLine => ({ kind: "spacer", text });
    // Chunk ends with \n — trailing empty part becomes spacer
    const result = appendDelta([dm("First line")], ".\n", "dm");
    expect(result).toEqual([dm("First line."), spacer("")]);
  });

  it("\\n split across chunks: spacer + non-\\n delta stays spacer", () => {
    const spacer = (text: string): NarrativeLine => ({ kind: "spacer", text });
    // Chunk 1 ends with \n (trailing spacer), chunk 2 is normal text
    const after1 = appendDelta([dm("First")], "\n", "dm");
    expect(after1).toEqual([dm("First"), spacer("")]);
    const after2 = appendDelta(after1, "Second", "dm");
    // Spacer stays — tags persist across it
    expect(after2).toEqual([dm("First"), spacer(""), dm("Second")]);
  });

  it("\\n\\n split across chunks: spacer promoted to dm blank", () => {
    // Chunk 1 ends with \n (trailing spacer), chunk 2 starts with \n (confirming \n\n)
    const after1 = appendDelta([dm("First")], "\n", "dm");
    const after2 = appendDelta(after1, "\nSecond", "dm");
    // Spacer promoted to dm("") — real paragraph boundary
    const hasDmBlank = after2.some((l) => l.kind === "dm" && l.text === "");
    expect(hasDmBlank).toBe(true);
  });
});
