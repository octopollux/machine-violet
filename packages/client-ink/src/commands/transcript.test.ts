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

  it("renders a <quote> block as a styled blockquote", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: "<quote>Here lies the <i>last honest broker</i>.</quote>" },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain('class="dm-quote"');
    expect(html).toContain("<blockquote");
    expect(html).toContain("<i>last honest broker</i>");
    // The literal tag must not leak.
    expect(html).not.toContain("&lt;quote&gt;");
  });

  it("renders an ordered list with markers and hanging indent", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: "1. Bread primary." },
      { kind: "dm", text: "2. Crackers forbidden." },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain('class="list-item"');
    expect(html).toContain("text-indent:-3ch");
    expect(html).toContain("1. ");
    expect(html).toContain("Bread primary.");
  });

  it("renders an unordered list with bullet glyphs", () => {
    const lines: NarrativeLine[] = [
      { kind: "dm", text: "- A coil of rope" },
      { kind: "dm", text: "- A spare lantern" },
    ];
    const html = buildTranscriptHtml(buildOpts(lines));
    expect(html).toContain('class="list-item"');
    expect(html).toContain("•");
    // The raw dash marker is replaced by the bullet glyph.
    expect(html).toContain("A coil of rope");
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

  it("marks inlined images as zoomable for the shadowbox", () => {
    const lines: NarrativeLine[] = [
      { kind: "image", text: "/path/to/scene-001-tavern-1234.png", intent: "scene_snapshot" },
    ];
    const opts: TranscriptOptions = {
      ...buildOpts(lines),
      imageBytes: {
        "/path/to/scene-001-tavern-1234.png": { mimeType: "image/png", base64: "X" },
      },
    };
    const html = buildTranscriptHtml(opts);
    expect(html).toContain('class="zoomable"');
    // Keyboard/screen-reader access: focusable + actionable semantics.
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="View image full screen"');
  });

  it("includes the shadowbox overlay scaffold and handler", () => {
    const html = buildTranscriptHtml(buildOpts([]));
    expect(html).toContain('id="shadowbox"');
    expect(html).toContain("#shadowbox.open");
    // Esc + backdrop-click close, image-click left to the browser.
    expect(html).toContain("'Escape'");
    expect(html).toContain("e.target !== boxImg");
    // Enter/Space open the shadowbox for keyboard-only users.
    expect(html).toContain("'Enter'");
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
    // No image element for the missing file. (The shadowbox scaffold emits a
    // src-less <img alt="">, so match on a sourced <img> specifically.)
    expect(html).not.toContain("<img src=");
  });
});
