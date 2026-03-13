import { loadModelConfig } from "../config/models.js";
import { resetContentPromptCache } from "./prompts/load-content-prompt.js";
import {
  getExtractorPrompt,
  buildExtractorBatchRequests,
  parseExtractorResults,
  writeDraftEntities,
} from "./extractors.js";
import type { CatalogSection, DraftEntity } from "./processing-types.js";
import type { FileIO } from "../agents/scene-manager.js";

/** Normalize backslashes for cross-platform assertions. */
const norm = (p: string) => p.replace(/\\/g, "/");

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetContentPromptCache();
});

describe("getExtractorPrompt", () => {
  it("returns different prompts for different content types", () => {
    const monstersPrompt = getExtractorPrompt("monsters");
    const spellsPrompt = getExtractorPrompt("spells");

    expect(monstersPrompt).toContain("monster");
    expect(spellsPrompt).toContain("spell");
    expect(monstersPrompt).not.toBe(spellsPrompt);
  });

  it("returns a prompt for every content type", () => {
    const types = ["monsters", "spells", "rules", "chargen", "equipment", "tables", "lore", "locations", "generic"] as const;
    for (const t of types) {
      expect(getExtractorPrompt(t).length).toBeGreaterThan(0);
    }
  });
});

describe("buildExtractorBatchRequests", () => {
  it("creates one request per section with correct prompt", () => {
    const sections: CatalogSection[] = [
      { contentType: "monsters", title: "Bestiary", description: "", startPage: 1, endPage: 20 },
      { contentType: "spells", title: "Spells", description: "", startPage: 21, endPage: 40 },
    ];
    const texts = ["page text 1", "page text 2"];

    const requests = buildExtractorBatchRequests(sections, texts, "d-d-5e");

    expect(requests).toHaveLength(2);
    expect(requests[0].custom_id).toBe("extract-d-d-5e-1-20");
    expect(requests[1].custom_id).toBe("extract-d-d-5e-21-40");
    expect(requests[0].params.model).toBe("claude-haiku-4-5-20251001");
    expect(requests[0].params.max_tokens).toBe(8192);
  });
});

describe("parseExtractorResults", () => {
  it("parses entities from batch results", () => {
    const sections: CatalogSection[] = [
      { contentType: "monsters", title: "Bestiary", description: "", startPage: 1, endPage: 20 },
    ];

    const results = [
      {
        customId: "extract-d-d-5e-1-20",
        text: `--- ENTITY ---
Name: Goblin
Category: characters
Slug: goblin

**Type:** Monster

A small green creature.

--- ENTITY ---
Name: Orc
Category: characters
Slug: orc

**Type:** Monster

A large brutish creature.`,
      },
    ];

    const entities = parseExtractorResults(results, sections, "d-d-5e");
    expect(entities).toHaveLength(2);
    expect(entities[0].name).toBe("Goblin");
    expect(entities[0].sourceSection).toBe("Bestiary");
    expect(entities[1].name).toBe("Orc");
  });

  it("skips errored results", () => {
    const sections: CatalogSection[] = [
      { contentType: "monsters", title: "Bestiary", description: "", startPage: 1, endPage: 20 },
    ];

    const results = [
      { customId: "extract-d-d-5e-1-20", error: "Batch failed" },
    ];

    const entities = parseExtractorResults(results, sections, "d-d-5e");
    expect(entities).toHaveLength(0);
  });
});

describe("writeDraftEntities", () => {
  it("writes entity files to correct paths", async () => {
    const files: Record<string, string> = {};
    const io: FileIO = {
      readFile: vi.fn(async (p: string) => files[p] ?? ""),
      writeFile: vi.fn(async (p: string, c: string) => { files[p] = c; }),
      appendFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      listDir: vi.fn(async () => []),
    };

    const entities: DraftEntity[] = [
      {
        name: "Goblin",
        category: "characters",
        slug: "goblin",
        frontMatter: { type: "Monster", cr: "1/4" },
        body: "A small green creature.",
      },
      {
        name: "Waterdeep",
        category: "locations",
        slug: "waterdeep",
        frontMatter: { type: "City" },
        body: "City of Splendors.",
      },
    ];

    const written = await writeDraftEntities(io, "/home", "d-d-5e", entities);
    expect(written).toBe(2);

    // Check mkdir was called for category directories
    expect(io.mkdir).toHaveBeenCalledTimes(2);

    // Check files were written
    const writeCalls = (io.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    expect(writeCalls).toHaveLength(2);

    const paths = writeCalls.map((c: [string, string]) => norm(c[0]));
    expect(paths.some((p: string) => p.includes("drafts/characters/goblin.md"))).toBe(true);
    expect(paths.some((p: string) => p.includes("drafts/locations/waterdeep.md"))).toBe(true);

    // Check content uses serializeEntity format
    const goblinContent = writeCalls.find((c: [string, string]) => c[0].includes("goblin"))?.[1] as string;
    expect(goblinContent).toContain("# Goblin");
    expect(goblinContent).toContain("**Type:** Monster");
  });

  it("returns 0 for empty entities", async () => {
    const io: FileIO = {
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
      appendFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      exists: vi.fn(async () => false),
      listDir: vi.fn(async () => []),
    };

    const written = await writeDraftEntities(io, "/home", "d-d-5e", []);
    expect(written).toBe(0);
  });
});
