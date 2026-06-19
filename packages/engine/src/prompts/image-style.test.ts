import { resolveImageStyleLine } from "./image-style.js";

describe("resolveImageStyleLine (real .mvstyle files on disk)", () => {
  it("returns the bare # Style sentence for a known style, backticks stripped", () => {
    const line = resolveImageStyleLine("CinematicFilm");
    expect(line).toBeTruthy();
    expect(line).toContain("35mm anamorphic");
    // Fences gone — the caller appends a raw render instruction.
    expect(line!.startsWith("`")).toBe(false);
    expect(line!.endsWith("`")).toBe(false);
  });

  it("omits the # Direction preamble (only the Style directive reaches the prompt)", () => {
    const line = resolveImageStyleLine("Image");
    expect(line).toContain("GPU-rendered Japanese MMO");
    // The Direction section's meta-instruction must NOT leak into the prompt.
    expect(line).not.toContain("When composing prompts");
  });

  it("returns null for an unknown style", () => {
    expect(resolveImageStyleLine("NoSuchStyle")).toBeNull();
  });

  it("rejects path-traversal / non-stem names without touching disk", () => {
    expect(resolveImageStyleLine("../okf")).toBeNull();
    expect(resolveImageStyleLine("Image/../Image")).toBeNull();
    expect(resolveImageStyleLine("")).toBeNull();
    expect(resolveImageStyleLine("with space")).toBeNull();
  });
});
