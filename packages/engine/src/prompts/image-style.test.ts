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

  it("resolves a campaign composite to its DEFAULT look only, not the whole menu", () => {
    // AThroneOfSalt is a composite: Default = ValueBlocked, situational =
    // LargeFormat70 ("wow" scenery). The portrait/gate must get a SINGLE
    // directive — the default — never the labeled menu or the situational line.
    const line = resolveImageStyleLine("AThroneOfSalt");
    expect(line).toBeTruthy();
    // It's the default (ValueBlocked) directive, in isolation…
    expect(line).toContain("value");
    // …with none of the composite's menu scaffolding leaking through:
    expect(line).not.toMatch(/`/); // no stray backtick fences
    expect(line).not.toContain("Default"); // no entry labels
    expect(line).not.toContain("LargeFormat70");
    expect(line).not.toMatch(/large format|70mm/i); // not the situational variant
    // A single directive is one paragraph — the menu would carry blank-line gaps.
    expect(line).not.toContain("\n\n");
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
