import { describe, it, expect } from "vitest";
import {
  parseIncludeFile,
  processIncludes,
  applyLayeredOverrides,
  type IncludeFile,
} from "./process-includes.js";

function fileOf(map: Record<string, string>): IncludeFile {
  return {
    variants: new Map(Object.entries(map)),
    isFlat: false,
    flatBody: "",
  };
}

function flatFile(body: string): IncludeFile {
  return { variants: new Map(), isFlat: true, flatBody: body };
}

describe("parseIncludeFile", () => {
  it("extracts top-level <Variant> sections", () => {
    const src = [
      "<Military>",
      "Three squads of the King's Guard.",
      "</Military>",
      "",
      "<Civilian>",
      "Merchant guild leader.",
      "</Civilian>",
    ].join("\n");
    const file = parseIncludeFile(src);
    expect(file.isFlat).toBe(false);
    expect(file.variants.get("Military")).toBe("Three squads of the King's Guard.");
    expect(file.variants.get("Civilian")).toBe("Merchant guild leader.");
  });

  it("returns a flat file when no top-level XML sections exist", () => {
    const src = "Just some narrative text, no XML at all.";
    const file = parseIncludeFile(src);
    expect(file.isFlat).toBe(true);
    expect(file.flatBody).toBe("Just some narrative text, no XML at all.");
    expect(file.variants.size).toBe(0);
  });

  it("ignores indented (non-column-0) XML when deciding section boundaries", () => {
    // The inner <b> is inside the Military body; it must not be promoted to
    // a sibling variant, and it must not break the regex.
    const src = [
      "<Military>",
      "Three <b>elite</b> squads.",
      "</Military>",
    ].join("\n");
    const file = parseIncludeFile(src);
    expect(file.variants.get("Military")).toBe("Three <b>elite</b> squads.");
    expect(file.variants.has("b")).toBe(false);
  });

  it("normalizes CRLF to LF", () => {
    const src = "<X>\r\nbody\r\n</X>\r\n";
    const file = parseIncludeFile(src);
    expect(file.variants.get("X")).toBe("body");
  });
});

describe("processIncludes", () => {
  it("replaces a dotted directive with <Stem>variant-body</Stem>", () => {
    const loader = (name: string) => {
      expect(name).toBe("NPCS");
      return fileOf({ Military: "Three squads." });
    };
    const out = processIncludes("before <!--include:NPCS.Military--> after", { loader });
    expect(out).toBe("before <NPCS>\nThree squads.\n</NPCS> after");
  });

  it("dotless directive picks the section named same as the file stem", () => {
    const loader = () => fileOf({
      NPCS: "Default world NPCs.",
      Military: "Three squads.",
    });
    const out = processIncludes("<!--include:NPCS-->", { loader });
    expect(out).toBe("<NPCS>\nDefault world NPCs.\n</NPCS>");
  });

  it("dotless directive on a flat file wraps the whole body", () => {
    const loader = () => flatFile("Whole file body.");
    const out = processIncludes("<!--include:NPCS-->", { loader });
    expect(out).toBe("<NPCS>\nWhole file body.\n</NPCS>");
  });

  it("emits the file-stem tag, never the variant name", () => {
    // The wrapping tag for NPCS.Military is <NPCS>, NOT <Military> or <NPCS.Military>.
    // This is the core "include picks a variant of the same entity" promise.
    const loader = () => fileOf({ Military: "body" });
    const out = processIncludes("<!--include:NPCS.Military-->", { loader });
    expect(out).toContain("<NPCS>");
    expect(out).toContain("</NPCS>");
    expect(out).not.toContain("<Military>");
    expect(out).not.toContain("<NPCS.Military>");
  });

  it("errors when a dotted variant is missing", () => {
    const loader = () => fileOf({ Military: "x", Civilian: "y" });
    expect(() => processIncludes("<!--include:NPCS.Pirate-->", { loader }))
      .toThrow(/Pirate.*Military, Civilian/);
  });

  it("errors when a dotless include has no matching default section", () => {
    const loader = () => fileOf({ Military: "x", Civilian: "y" });
    expect(() => processIncludes("<!--include:NPCS-->", { loader }))
      .toThrow(/no default <NPCS> section/);
  });

  it("errors when a dotted variant is requested on a flat file", () => {
    const loader = () => flatFile("body");
    expect(() => processIncludes("<!--include:NPCS.Military-->", { loader }))
      .toThrow(/flat file/);
  });

  it("resolves multiple directives in one pass", () => {
    const loader = (name: string) => {
      if (name === "A") return flatFile("a-body");
      if (name === "B") return fileOf({ B: "b-default", Alt: "b-alt" });
      throw new Error(`unexpected ${name}`);
    };
    const src = "<!--include:A-->\n<!--include:B-->\n<!--include:B.Alt-->";
    const out = processIncludes(src, { loader });
    expect(out).toBe(
      "<A>\na-body\n</A>\n<B>\nb-default\n</B>\n<B>\nb-alt\n</B>",
    );
  });

  it("passes through text with no directives", () => {
    const loader = () => {
      throw new Error("should not load");
    };
    expect(processIncludes("no directives here", { loader })).toBe("no directives here");
  });
});

describe("applyLayeredOverrides", () => {
  it("preserves layers when tags don't collide", () => {
    const layers = [
      "<A>\nfrom-1\n</A>",
      "<B>\nfrom-2\n</B>",
      "<C>\nfrom-3\n</C>",
    ];
    expect(applyLayeredOverrides(layers)).toEqual(layers);
  });

  it("removes earlier-layer occurrences when a later layer redefines the same tag", () => {
    const [main, seed, persona] = applyLayeredOverrides([
      "<NPCS>\nmain-version\n</NPCS>",
      "<NPCS>\nseed-version\n</NPCS>",
      "<NPCS>\npersona-version\n</NPCS>",
    ]);
    expect(main).toBe("");
    expect(seed).toBe("");
    expect(persona).toBe("<NPCS>\npersona-version\n</NPCS>");
  });

  it("removes only the colliding tag, leaving siblings intact", () => {
    const [main, persona] = applyLayeredOverrides([
      "<A>\nkeep-me\n</A>\n<B>\nlose-me\n</B>",
      "<B>\nwinner\n</B>",
    ]);
    expect(main).toContain("<A>");
    expect(main).toContain("keep-me");
    expect(main).not.toContain("lose-me");
    expect(persona).toBe("<B>\nwinner\n</B>");
  });

  it("within a single layer, last occurrence wins", () => {
    const [out] = applyLayeredOverrides([
      "<X>\nfirst\n</X>\nmiddle\n<X>\nlast\n</X>",
    ]);
    expect(out).toContain("last");
    expect(out).not.toContain("first");
  });

  it("preserves position of the surviving block in its layer", () => {
    // <A> defined only in layer 0 should stay where it was; <B> defined in
    // layer 1 stays in layer 1's text. Layer 0's <B> gets removed.
    const [main, persona] = applyLayeredOverrides([
      "before-A\n<A>\nkept\n</A>\nbetween\n<B>\ndropped\n</B>\nafter",
      "before-B\n<B>\nkept\n</B>\nafter-B",
    ]);
    expect(main).toMatch(/before-A\n<A>\nkept\n<\/A>\nbetween\n+after/);
    expect(persona).toBe("before-B\n<B>\nkept\n</B>\nafter-B");
  });

  it("ignores indented XML and inline formatting tags", () => {
    // `- <b>x</b>` is not at column 0; must be left alone.
    const layers = [
      "## heading\n- <b>scribe</b>: a tool\n- <color=#fff>red</color>: a color",
      "<TOOLS>\nreplacement\n</TOOLS>",
    ];
    const out = applyLayeredOverrides(layers);
    expect(out[0]).toContain("<b>scribe</b>");
    expect(out[0]).toContain("<color=#fff>red</color>");
    expect(out[1]).toBe("<TOOLS>\nreplacement\n</TOOLS>");
  });
});
