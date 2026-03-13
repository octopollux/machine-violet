import { loadModelConfig } from "../config/models.js";
import { resetContentPromptCache } from "./prompts/load-content-prompt.js";
import {
  computeChunks,
  loadChunkPages,
  buildClassifierBatchRequests,
  parseClassifierResults,
  mergeSections,
  buildCatalog,
  CHUNK_WINDOW,
  CHUNK_OVERLAP,
} from "./classifier.js";
import type { CatalogSection } from "./processing-types.js";
import type { FileIO } from "../agents/scene-manager.js";

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetContentPromptCache();
});

// --- Chunking ---

describe("computeChunks", () => {
  it("creates correct chunks for a small page count", () => {
    const chunks = computeChunks(10, 20, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, startPage: 1, endPage: 10 });
  });

  it("creates overlapping chunks for larger page counts", () => {
    const chunks = computeChunks(50, 20, 2);
    // stride = 18, so: 1-20, 19-38, 37-50
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ index: 0, startPage: 1, endPage: 20 });
    expect(chunks[1]).toEqual({ index: 1, startPage: 19, endPage: 38 });
    expect(chunks[2]).toEqual({ index: 2, startPage: 37, endPage: 50 });
  });

  it("handles 343 pages (typical sourcebook)", () => {
    const chunks = computeChunks(343, CHUNK_WINDOW, CHUNK_OVERLAP);
    // stride = 18, ceil(343/18) ≈ 20 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(18);
    expect(chunks.length).toBeLessThanOrEqual(20);

    // First chunk starts at 1
    expect(chunks[0].startPage).toBe(1);
    // Last chunk ends at 343
    expect(chunks[chunks.length - 1].endPage).toBe(343);

    // Overlap check: each chunk's start should be <= previous chunk's end
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startPage).toBeLessThanOrEqual(chunks[i - 1].endPage);
    }
  });

  it("handles single page", () => {
    const chunks = computeChunks(1, 20, 2);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, startPage: 1, endPage: 1 });
  });
});

// --- Loading chunk pages ---

describe("loadChunkPages", () => {
  it("loads and concatenates page files", async () => {
    const io: FileIO = {
      readFile: vi.fn(async (p: string) => {
        if (p.includes("0001")) return "Page 1 text";
        if (p.includes("0002")) return "Page 2 text";
        return "";
      }),
      writeFile: vi.fn(async () => {}),
      appendFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      exists: vi.fn(async () => true),
      listDir: vi.fn(async () => []),
    };

    const text = await loadChunkPages(io, "/home", "d-d-5e", "dmg", {
      index: 0,
      startPage: 1,
      endPage: 2,
    });

    expect(text).toContain("--- PAGE 1 ---");
    expect(text).toContain("Page 1 text");
    expect(text).toContain("--- PAGE 2 ---");
    expect(text).toContain("Page 2 text");
  });

  it("skips missing pages", async () => {
    const io: FileIO = {
      readFile: vi.fn(async () => "text"),
      writeFile: vi.fn(async () => {}),
      appendFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      exists: vi.fn(async (p: string) => p.includes("0001")),
      listDir: vi.fn(async () => []),
    };

    const text = await loadChunkPages(io, "/home", "d-d-5e", "dmg", {
      index: 0,
      startPage: 1,
      endPage: 3,
    });

    expect(text).toContain("--- PAGE 1 ---");
    expect(text).not.toContain("--- PAGE 2 ---");
    expect(text).not.toContain("--- PAGE 3 ---");
  });
});

// --- Batch request building ---

describe("buildClassifierBatchRequests", () => {
  it("creates one request per chunk", () => {
    const chunks = computeChunks(40, 20, 2);
    const texts = chunks.map((c) => `Pages ${c.startPage}-${c.endPage}`);
    const requests = buildClassifierBatchRequests(chunks, texts, "d-d-5e");

    expect(requests).toHaveLength(chunks.length);
    expect(requests[0].custom_id).toBe("classify-d-d-5e-1-20");
    expect(requests[0].params.model).toBe("claude-haiku-4-5-20251001");
    expect(requests[0].params.max_tokens).toBe(4096);
  });
});

// --- Result parsing ---

describe("parseClassifierResults", () => {
  it("parses valid JSON results", () => {
    const results = [
      {
        customId: "classify-1",
        text: JSON.stringify([
          {
            contentType: "monsters",
            title: "Bestiary",
            description: "Monster stat blocks",
            startPage: 1,
            endPage: 20,
          },
        ]),
      },
    ];

    const sections = parseClassifierResults(results);
    expect(sections).toHaveLength(1);
    expect(sections[0].contentType).toBe("monsters");
    expect(sections[0].title).toBe("Bestiary");
  });

  it("handles JSON in code fences", () => {
    const results = [
      {
        customId: "classify-1",
        text: '```json\n[{"contentType":"spells","title":"Spells","description":"","startPage":1,"endPage":10}]\n```',
      },
    ];

    const sections = parseClassifierResults(results);
    expect(sections).toHaveLength(1);
    expect(sections[0].contentType).toBe("spells");
  });

  it("skips errored results", () => {
    const results = [
      { customId: "classify-1", error: "API error" },
      {
        customId: "classify-2",
        text: JSON.stringify([
          { contentType: "rules", title: "Rules", description: "", startPage: 1, endPage: 5 },
        ]),
      },
    ];

    const sections = parseClassifierResults(results);
    expect(sections).toHaveLength(1);
  });

  it("skips malformed JSON", () => {
    const results = [
      { customId: "classify-1", text: "not json at all" },
    ];

    const sections = parseClassifierResults(results);
    expect(sections).toHaveLength(0);
  });

  it("defaults invalid content types to generic", () => {
    const results = [
      {
        customId: "classify-1",
        text: JSON.stringify([
          { contentType: "unknown_type", title: "Misc", description: "", startPage: 1, endPage: 5 },
        ]),
      },
    ];

    const sections = parseClassifierResults(results);
    expect(sections[0].contentType).toBe("generic");
  });

  it("skips entries missing required fields", () => {
    const results = [
      {
        customId: "classify-1",
        text: JSON.stringify([
          { contentType: "rules", title: "Rules" }, // missing page numbers
          { contentType: "lore", title: "Lore", startPage: 1, endPage: 10 },
        ]),
      },
    ];

    const sections = parseClassifierResults(results);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe("Lore");
  });
});

// --- Section merging ---

describe("mergeSections", () => {
  it("merges sections with same title and overlapping pages", () => {
    const sections: CatalogSection[] = [
      { contentType: "monsters", title: "Bestiary", description: "Part 1", startPage: 1, endPage: 20 },
      { contentType: "monsters", title: "Bestiary", description: "Part 2", startPage: 19, endPage: 40 },
    ];

    const merged = mergeSections(sections);
    expect(merged).toHaveLength(1);
    expect(merged[0].startPage).toBe(1);
    expect(merged[0].endPage).toBe(40);
  });

  it("merges adjacent sections (no gap)", () => {
    const sections: CatalogSection[] = [
      { contentType: "rules", title: "Combat", description: "", startPage: 1, endPage: 10 },
      { contentType: "rules", title: "Combat", description: "", startPage: 11, endPage: 20 },
    ];

    const merged = mergeSections(sections);
    expect(merged).toHaveLength(1);
    expect(merged[0].endPage).toBe(20);
  });

  it("keeps sections with different titles separate", () => {
    const sections: CatalogSection[] = [
      { contentType: "rules", title: "Combat", description: "", startPage: 1, endPage: 10 },
      { contentType: "rules", title: "Magic", description: "", startPage: 8, endPage: 20 },
    ];

    const merged = mergeSections(sections);
    expect(merged).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(mergeSections([])).toEqual([]);
  });

  it("handles single section", () => {
    const sections: CatalogSection[] = [
      { contentType: "lore", title: "History", description: "", startPage: 1, endPage: 5 },
    ];

    const merged = mergeSections(sections);
    expect(merged).toHaveLength(1);
  });
});

// --- Catalog building ---

describe("buildCatalog", () => {
  it("builds catalog with merged sections", () => {
    const sections: CatalogSection[] = [
      { contentType: "monsters", title: "Bestiary", description: "", startPage: 1, endPage: 20 },
      { contentType: "monsters", title: "Bestiary", description: "", startPage: 19, endPage: 40 },
      { contentType: "spells", title: "Spells", description: "", startPage: 41, endPage: 60 },
    ];

    const catalog = buildCatalog("d-d-5e", sections, 60);
    expect(catalog.collectionSlug).toBe("d-d-5e");
    expect(catalog.totalPages).toBe(60);
    expect(catalog.sections).toHaveLength(2); // Bestiary merged
    expect(catalog.sections[0].endPage).toBe(40);
  });
});
