import { describe, it, expect } from "vitest";
import { buildTranscriptHtml, type TranscriptOptions } from "./transcript.js";
import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";
import type { ThemeAsset } from "../tui/themes/types.js";

/** Minimal theme asset stub for tests. */
function stubAsset(): ThemeAsset {
  return {
    name: "test",
    genre_tags: [],
    height: 3,
    variants: {} as never,
    components: {
      turn_separator: { rows: ["── † ──"], width: 7, height: 1 },
    },
  } as ThemeAsset;
}

function buildOpts(lines: NarrativeLine[], width = 80): TranscriptOptions {
  return {
    narrativeLines: lines,
    width,
    campaignName: "Test Campaign",
    themeAsset: stubAsset(),
    separatorColor: "#666666",
    playerColor: "#55ff55",
    quoteColor: "#ffffff",
  };
}

describe("buildTranscriptHtml", () => {
  it("produces a valid HTML document", () => {
    const html = buildTranscriptHtml(buildOpts([]));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("Test Campaign");
  });

  it("sets max-width to match column count", () => {
    const html = buildTranscriptHtml(buildOpts([], 120));
    expect(html).toContain("max-width: 120ch");
  });

  it("renders DM lines with formatting", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: "The door <b>groans</b> open." },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain("<b>groans</b>");
    expect(html).toContain('class="dm"');
  });

  it("renders player lines with player color", () => {
    const lines: NarrativeLine[] = [
      { kind: "player", text: "> I open the door." },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain('class="player"');
    expect(html).toContain('class="prompt"');
    expect(html).toContain("color:#55ff55");
  });

  it("renders system lines", () => {
    const lines: NarrativeLine[] = [
      { kind: "system", text: "[Saved: abc1234]" },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain('class="system"');
    expect(html).toContain("[Saved: abc1234]");
  });

  it("renders separators with theme text", () => {
    const lines: NarrativeLine[] = [
      { kind: "separator", text: "---" },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain('class="separator"');
    expect(html).toContain("†");
  });

  it("renders color tags as styled spans", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: '<color=#cc0000>danger</color>' },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain('style="color:#cc0000"');
    expect(html).toContain("danger");
  });

  it("omits dev lines from export", () => {
    const lines: NarrativeLine[] = [
      { kind: "dev", text: "[dev] some debug info" },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).not.toContain("debug info");
  });

  it("escapes HTML entities in text", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: "A < B & C > D" },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain("A &lt; B &amp; C &gt; D");
  });

  it("uses monospace font stack with Windows priority", () => {
    const html = buildTranscriptHtml(buildOpts([]));
    expect(html).toContain("Cascadia");
    expect(html).toContain("Consolas");
    expect(html).toContain("Menlo");
    expect(html).toContain("monospace");
  });

  it("inlines image lines as base64 data: URIs when bytes are supplied", () => {
    const lines: NarrativeLine[] = [
      { kind: "image", text: "/path/to/scene-001-tavern-1234.png", intent: "scene_snapshot" },
    ];
    const opts: TranscriptOptions = {
      ...buildOpts(lines),
      imageBytes: {
        "/path/to/scene-001-tavern-1234.png": {
          mimeType: "image/png",
          base64: "PNG-FAKE-BYTES",
        },
      },
    };
    const html = buildTranscriptHtml(opts);
    expect(html).toContain(`<img src="data:image/png;base64,PNG-FAKE-BYTES"`);
    expect(html).toContain('class="image"');
    expect(html).not.toContain("image-missing");
  });

  it("emits an [image unavailable] placeholder when bytes are missing", () => {
    const lines: NarrativeLine[] = [
      { kind: "image", text: "/path/that/was/deleted.png", intent: "player_request" },
    ];
    // No imageBytes supplied — simulates the file having been moved/deleted
    // between when the DM generated it and when the user exported the
    // transcript.
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain("[image unavailable]");
    expect(html).not.toContain("<img");
  });
});
