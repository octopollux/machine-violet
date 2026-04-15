/**
 * Regression guard for #403: the Campaign Explorer must flatten system-prompt
 * dumps that use the engine's SystemBlock shape ({ text, cacheControl? }),
 * which has no `type` field. The older Anthropic SDK shape with
 * `{ type: "text", text }` must also still render.
 */
import { describe, it, expect } from "vitest";
import { systemPromptToText } from "../../src/client/components/ContextDumpViewer.js";

describe("systemPromptToText", () => {
  it("renders engine SystemBlock dumps (no type field)", () => {
    const text = systemPromptToText([
      { text: "DM identity" },
      { text: "\n\nPersonality", cacheControl: { ttl: "1h" } },
    ]);
    expect(text).toContain("DM identity");
    expect(text).toContain("Personality");
  });

  it("renders SDK-shaped blocks with type: 'text'", () => {
    const text = systemPromptToText([
      { type: "text", text: "SDK block one" },
      { type: "text", text: "SDK block two" },
    ]);
    expect(text).toContain("SDK block one");
    expect(text).toContain("SDK block two");
  });

  it("passes plain-string system prompts through unchanged", () => {
    expect(systemPromptToText("already plain")).toBe("already plain");
  });

  it("skips blocks with a non-text type (defensive)", () => {
    const text = systemPromptToText([
      { text: "kept" },
      { type: "image", text: "dropped" } as { type?: string; text?: string },
    ]);
    expect(text).toContain("kept");
    expect(text).not.toContain("dropped");
  });
});
