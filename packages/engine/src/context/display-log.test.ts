import { describe, it, expect } from "vitest";
import { narrativeLinesToMarkdown, markdownToNarrativeLines, tailLines, iterDisplayLogReplay } from "./display-log.js";
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

  it("relativizes image paths under the campaign root on write", () => {
    const lines: NarrativeLine[] = [
      { kind: "image", text: "/campaigns/foo/campaign/images/scene-1.png", intent: "scene_snapshot" },
    ];
    const md = narrativeLinesToMarkdown(lines, "/campaigns/foo");
    expect(md).toBe("[image:scene_snapshot] campaign/images/scene-1.png\n");
  });

  it("absolutizes image paths against the campaign root on read", () => {
    const lines = markdownToNarrativeLines(
      ["[image:scene_snapshot] campaign/images/scene-1.png"],
      "/campaigns/foo",
    );
    expect(lines).toEqual([
      { kind: "image", text: "/campaigns/foo/campaign/images/scene-1.png", intent: "scene_snapshot" },
    ]);
  });

  it("passes absolute paths through unchanged on read (legacy display-logs)", () => {
    const lines = markdownToNarrativeLines(
      ["[image:player_request] /elsewhere/img.png"],
      "/campaigns/foo",
    );
    expect(lines).toEqual([
      { kind: "image", text: "/elsewhere/img.png", intent: "player_request" },
    ]);
  });

  it("handles Windows-style absolute paths on read", () => {
    const lines = markdownToNarrativeLines(
      ["[image:scene_snapshot] C:\\campaigns\\foo\\img.png"],
      "C:\\campaigns\\foo",
    );
    expect(lines).toEqual([
      { kind: "image", text: "C:\\campaigns\\foo\\img.png", intent: "scene_snapshot" },
    ]);
  });

  it("relativizes Windows-style absolute paths when they sit under the root", () => {
    const lines: NarrativeLine[] = [
      { kind: "image", text: "C:\\campaigns\\foo\\campaign\\images\\img.png", intent: "scene_snapshot" },
    ];
    const md = narrativeLinesToMarkdown(lines, "C:\\campaigns\\foo");
    // Result uses forward slashes for portability across platforms
    expect(md).toBe("[image:scene_snapshot] campaign/images/img.png\n");
  });

  it("leaves image paths absolute when no campaign root is supplied", () => {
    const lines: NarrativeLine[] = [
      { kind: "image", text: "/some/abs/img.png", intent: "scene_snapshot" },
    ];
    expect(narrativeLinesToMarkdown(lines)).toBe("[image:scene_snapshot] /some/abs/img.png\n");
  });

  it("falls back to original path when the image isn't under the campaign root", () => {
    // User loaded an external image into their campaign — better to keep
    // a working absolute path than invent a broken relative one.
    const lines: NarrativeLine[] = [
      { kind: "image", text: "/elsewhere/external.png", intent: "player_request" },
    ];
    const md = narrativeLinesToMarkdown(lines, "/campaigns/foo");
    expect(md).toBe("[image:player_request] /elsewhere/external.png\n");
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

describe("iterDisplayLogReplay", () => {
  it("groups consecutive same-kind lines into one chunk", () => {
    const events = [...iterDisplayLogReplay([
      { kind: "dm", text: "Hello." },
      { kind: "dm", text: "World." },
    ])];
    expect(events).toEqual([
      { type: "narrative:chunk", data: { text: "Hello.\nWorld.", kind: "dm" } },
    ]);
  });

  it("flushes the pending chunk before a kind transition", () => {
    const events = [...iterDisplayLogReplay([
      { kind: "player", text: "[Aldric] I open the door." },
      { kind: "dm", text: "The door creaks open." },
    ])];
    expect(events).toEqual([
      { type: "narrative:chunk", data: { text: "[Aldric] I open the door.", kind: "player" } },
      { type: "narrative:chunk", data: { text: "The door creaks open.", kind: "dm" } },
    ]);
  });

  it("flushes the pending chunk before an image, then emits display_image", () => {
    // The exact wire shape the live engine emits — keeps the client
    // event-handler rendering replay identically to live play.
    const events = [...iterDisplayLogReplay([
      { kind: "dm", text: "The room is filled." },
      { kind: "image", text: "/campaigns/foo/images/scene.png", intent: "scene_snapshot" },
      { kind: "dm", text: "Inside, lamplight." },
    ])];
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: "narrative:chunk",
      data: { text: "The room is filled.", kind: "dm" },
    });
    expect(events[1]).toEqual({
      type: "activity:update",
      data: {
        engineState: "tui:display_image",
        type: "display_image",
        filename: "/campaigns/foo/images/scene.png",
        intent: "scene_snapshot",
      },
    });
    expect(events[2]).toEqual({
      type: "narrative:chunk",
      data: { text: "Inside, lamplight.", kind: "dm" },
    });
  });

  it("preserves all three intent values in display_image events", () => {
    const events = [...iterDisplayLogReplay([
      { kind: "image", text: "/a.png", intent: "scene_snapshot" },
      { kind: "image", text: "/b.png", intent: "player_request" },
      { kind: "image", text: "/c.png", intent: "character_portrait" },
    ])];
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type === "activity:update" ? e.data.intent : null)).toEqual([
      "scene_snapshot",
      "player_request",
      "character_portrait",
    ]);
  });

  it("converts separator lines to dm '---' for the formatting pipeline", () => {
    const events = [...iterDisplayLogReplay([
      { kind: "separator", text: "---" },
      { kind: "dm", text: "The door creaks open." },
    ])];
    expect(events).toEqual([
      { type: "narrative:chunk", data: { text: "---\nThe door creaks open.", kind: "dm" } },
    ]);
  });

  it("skips spacer lines (presentation-only)", () => {
    const events = [...iterDisplayLogReplay([
      { kind: "dm", text: "Before." },
      { kind: "spacer", text: " " },
      { kind: "dm", text: "After." },
    ])];
    // Spacer is dropped; the two DM lines coalesce.
    expect(events).toEqual([
      { type: "narrative:chunk", data: { text: "Before.\nAfter.", kind: "dm" } },
    ]);
  });

  it("yields nothing for an empty input", () => {
    const events = [...iterDisplayLogReplay([])];
    expect(events).toEqual([]);
  });

  it("handles a transcript that ends on an image (no trailing chunk)", () => {
    const events = [...iterDisplayLogReplay([
      { kind: "dm", text: "The door opens." },
      { kind: "image", text: "/img.png", intent: "scene_snapshot" },
    ])];
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("narrative:chunk");
    expect(events[1].type).toBe("activity:update");
  });

  it("handles multiple consecutive images (each flushed individually)", () => {
    const events = [...iterDisplayLogReplay([
      { kind: "image", text: "/a.png", intent: "scene_snapshot" },
      { kind: "image", text: "/b.png", intent: "player_request" },
    ])];
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "activity:update")).toBe(true);
  });

  it("replays a realistic Palimpsest-style turn end-to-end", () => {
    // Regression scaffold for the bug that motivated this feature:
    // a saved campaign with a separator → player → separator → dm... →
    // image sequence should land the image at the correct ordinal
    // position. Note that separators are emitted as dm "---" chunks,
    // which means a `separator → player` boundary still breaks the run
    // (different kinds): the sep yields a 1-line dm chunk on its own
    // before the player chunk starts.
    const events = [...iterDisplayLogReplay([
      { kind: "separator", text: "---" },
      { kind: "player", text: "[Oros] I offer the door." },
      { kind: "separator", text: "---" },
      { kind: "dm", text: "Mizân weighs the offer." },
      { kind: "dm", text: "" },
      { kind: "dm", text: "The green door rises in the table's reflection." },
      { kind: "image", text: "/p/courtyard.png", intent: "player_request" },
      { kind: "dm", text: "" }, // trailing paragraph break — empty, doesn't emit
    ])];
    expect(events.map((e) => e.type)).toEqual([
      "narrative:chunk", // sep → dm "---"
      "narrative:chunk", // player line
      "narrative:chunk", // sep + dm run, joined: "---\nMizân...\n\nThe green door..."
      "activity:update", // image
    ]);
    // Image is at index 3 — last event, immediately following the
    // long DM chunk that introduced it.
    expect(events[3]).toMatchObject({
      type: "activity:update",
      data: { filename: "/p/courtyard.png", intent: "player_request" },
    });
    // And the long DM chunk really does fold separator + DM together.
    expect(events[2]).toMatchObject({
      type: "narrative:chunk",
      data: { kind: "dm", text: "---\nMizân weighs the offer.\n\nThe green door rises in the table's reflection." },
    });
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
