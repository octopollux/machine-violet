import { describe, it, expect } from "vitest";
import { narrativeLinesToMarkdown, markdownToNarrativeLines, tailLines } from "./display-log.js";
import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";

describe("narrativeLinesToMarkdown", () => {
  it("converts dm lines as-is", () => {
    const lines: NarrativeLine[] = [{ kind: "dm", text: "The tavern is warm." }];
    expect(narrativeLinesToMarkdown(lines)).toBe("The tavern is warm.\n");
  });

  it("converts player lines with blockquote prefix", () => {
    const lines: NarrativeLine[] = [{ kind: "player", text: "[Aldric] I open the door." }];
    expect(narrativeLinesToMarkdown(lines)).toBe("> [Aldric] I open the door.\n");
  });

  it("converts system lines with [system] prefix", () => {
    const lines: NarrativeLine[] = [{ kind: "system", text: "Welcome back." }];
    expect(narrativeLinesToMarkdown(lines)).toBe("[system] Welcome back.\n");
  });

  it("converts separator lines to ---", () => {
    const lines: NarrativeLine[] = [{ kind: "separator", text: "---" }];
    expect(narrativeLinesToMarkdown(lines)).toBe("---\n");
  });

  it("excludes dev lines", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: "Hello" },
      { kind: "dev", text: "[dev] debug info" },
      { kind: "dm", text: "World" },
    ];
    expect(narrativeLinesToMarkdown(lines)).toBe("Hello\nWorld\n");
  });

  it("handles mixed line kinds", () => {
    const lines: NarrativeLine[] = [
      { kind: "player", text: "[Aldric] What do you see?" },
      { kind: "dm", text: "The room is dark." },
      { kind: "dm", text: "" },
    ];
    expect(narrativeLinesToMarkdown(lines)).toBe(
      "> [Aldric] What do you see?\nThe room is dark.\n\n",
    );
  });
});

describe("markdownToNarrativeLines", () => {
  it("parses blockquotes as player lines", () => {
    const result = markdownToNarrativeLines(["> [Aldric] I look around."]);
    expect(result).toEqual([{ kind: "player", text: "[Aldric] I look around." }]);
  });

  it("parses [system] prefix as system lines", () => {
    const result = markdownToNarrativeLines(["[system] Welcome back."]);
    expect(result).toEqual([{ kind: "system", text: "Welcome back." }]);
  });

  it("parses --- as separator", () => {
    const result = markdownToNarrativeLines(["---"]);
    expect(result).toEqual([{ kind: "separator", text: "---" }]);
  });

  it("parses everything else as dm lines", () => {
    const result = markdownToNarrativeLines(["The tavern is warm.", ""]);
    expect(result).toEqual([
      { kind: "dm", text: "The tavern is warm." },
      { kind: "dm", text: "" },
    ]);
  });

  it("round-trips through markdown", () => {
    const original: NarrativeLine[] = [
      { kind: "player", text: "[Aldric] Attack!" },
      { kind: "dm", text: "The goblin dodges." },
      { kind: "dm", text: "" },
      { kind: "system", text: "Session 2" },
    ];
    const md = narrativeLinesToMarkdown(original);
    const parsed = markdownToNarrativeLines(md.split("\n").slice(0, -1)); // trim trailing empty from split
    expect(parsed).toEqual(original);
  });

  it("round-trips turn separators before player and DM", () => {
    // Mirrors the display log format produced by processInput:
    // separator → player line → separator → DM response → blank paragraph break
    const original: NarrativeLine[] = [
      { kind: "separator", text: "---" },
      { kind: "player", text: "[Velvet] I open the door." },
      { kind: "separator", text: "---" },
      { kind: "dm", text: "The door creaks open." },
      { kind: "dm", text: "" },
    ];
    const md = narrativeLinesToMarkdown(original);
    expect(md).toBe("---\n> [Velvet] I open the door.\n---\nThe door creaks open.\n\n");
    const parsed = markdownToNarrativeLines(md.split("\n").slice(0, -1));
    expect(parsed).toEqual(original);
  });

  it("parses [image:intent] path as image lines", () => {
    const result = markdownToNarrativeLines([
      "[image:scene_snapshot] /campaigns/foo/campaign/images/scene-1.png",
      "[image:player_request] C:\\Users\\x\\img.png",
      "[image:character_portrait] /tmp/portrait.png",
    ]);
    expect(result).toEqual([
      { kind: "image", text: "/campaigns/foo/campaign/images/scene-1.png", intent: "scene_snapshot" },
      { kind: "image", text: "C:\\Users\\x\\img.png", intent: "player_request" },
      { kind: "image", text: "/tmp/portrait.png", intent: "character_portrait" },
    ]);
  });

  it("falls back to dm for image markers with unknown intent", () => {
    // Guards the parse against typos / future intents we don't yet know.
    // The line still appears in scrollback as a DM line rather than
    // vanishing or crashing — preferable to silent data loss.
    const result = markdownToNarrativeLines(["[image:weird_new_intent] /tmp/x.png"]);
    expect(result).toEqual([{ kind: "dm", text: "[image:weird_new_intent] /tmp/x.png" }]);
  });

  it("round-trips image lines through markdown", () => {
    // Regression guard for the Palimpsest scene-image bug: without this
    // roundtrip, images persist on disk but disappear from in-game
    // scrollback after a session reload.
    const original: NarrativeLine[] = [
      { kind: "dm", text: "The door creaks open." },
      { kind: "image", text: "/path/to/scene.png", intent: "scene_snapshot" },
      { kind: "dm", text: "Inside, lamplight." },
    ];
    const md = narrativeLinesToMarkdown(original);
    expect(md).toContain("[image:scene_snapshot] /path/to/scene.png");
    const parsed = markdownToNarrativeLines(md.split("\n").slice(0, -1));
    expect(parsed).toEqual(original);
  });

  it("skipTranscript turns omit separator and player line", () => {
    // Session open/resume: only the DM response is logged
    const original: NarrativeLine[] = [
      { kind: "dm", text: "Welcome to the adventure." },
      { kind: "dm", text: "" },
    ];
    const md = narrativeLinesToMarkdown(original);
    expect(md).toBe("Welcome to the adventure.\n\n");
    const parsed = markdownToNarrativeLines(md.split("\n").slice(0, -1));
    expect(parsed).toEqual(original);
  });
});

describe("tailLines", () => {
  it("returns last N lines", () => {
    expect(tailLines("a\nb\nc\nd\ne", 3)).toEqual(["c", "d", "e"]);
  });

  it("returns all lines when fewer than max", () => {
    expect(tailLines("a\nb", 10)).toEqual(["a", "b"]);
  });

  it("returns empty array for empty input", () => {
    expect(tailLines("", 10)).toEqual([]);
  });

  it("trims trailing blank lines", () => {
    expect(tailLines("a\nb\n\n\n", 10)).toEqual(["a", "b"]);
  });
});
