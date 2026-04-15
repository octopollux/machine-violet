import { loadModelConfig } from "../config/models.js";
import { resetContentPromptCache } from "./prompts/load-content-prompt.js";
import { listDraftEntities, runMerge } from "./merge.js";
import type { FileIO } from "../agents/scene-manager.js";
import { makeMockProvider } from "./test-helpers.js";

/** Normalize backslashes for cross-platform assertions. */
const norm = (p: string) => p.replace(/\\/g, "/");

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetContentPromptCache();
});

/** Build in-memory FileIO with pre-populated files. */
function mockIO(initial: Record<string, string> = {}): FileIO & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    readFile: vi.fn(async (p: string) => {
      const key = norm(p);
      for (const [k, v] of Object.entries(files)) {
        if (norm(k) === key) return v;
      }
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async (p: string, c: string) => { files[norm(p)] = c; }),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => {
      const key = norm(p);
      return Object.keys(files).some((k) => {
        const nk = norm(k);
        return nk === key || nk.startsWith(key + "/");
      });
    }),
    listDir: vi.fn(async (p: string) => {
      const dir = norm(p);
      const entries = new Set<string>();
      for (const k of Object.keys(files)) {
        const nk = norm(k);
        if (nk.startsWith(dir + "/")) {
          const rest = nk.slice(dir.length + 1);
          const firstPart = rest.split("/")[0];
          entries.add(firstPart);
        }
      }
      return [...entries];
    }),
  };
}

describe("listDraftEntities", () => {
  it("lists draft entities across categories", async () => {
    const io = mockIO({
      "/home/systems/d-d-5e/drafts/characters/goblin.md": "# Goblin",
      "/home/systems/d-d-5e/drafts/characters/orc.md": "# Orc",
      "/home/systems/d-d-5e/drafts/locations/waterdeep.md": "# Waterdeep",
    });

    const drafts = await listDraftEntities(io, "/home", "d-d-5e");
    expect(drafts).toHaveLength(3);

    const slugs = drafts.map((d) => d.slug).sort();
    expect(slugs).toEqual(["goblin", "orc", "waterdeep"]);
  });

  it("returns empty when no drafts exist", async () => {
    const io = mockIO({});
    const drafts = await listDraftEntities(io, "/home", "d-d-5e");
    expect(drafts).toHaveLength(0);
  });
});

describe("runMerge", () => {
  const mockProvider = makeMockProvider("# Merged Entity\n\nMerged content.");

  it("creates new entities (no existing version)", async () => {
    const io = mockIO({
      "/home/systems/d-d-5e/drafts/characters/goblin.md": "# Goblin\n\nNew creature.",
    });

    const result = await runMerge(mockProvider, io, "/home", "d-d-5e");
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.merged).toBe(0);

    // Check entity was written
    expect(io.files["/home/systems/d-d-5e/entities/characters/goblin.md"]).toBe(
      "# Goblin\n\nNew creature.",
    );
  });

  it("skips identical entities", async () => {
    const content = "# Goblin\n\nSame content.";
    const io = mockIO({
      "/home/systems/d-d-5e/drafts/characters/goblin.md": content,
      "/home/systems/d-d-5e/entities/characters/goblin.md": content,
    });

    const result = await runMerge(mockProvider, io, "/home", "d-d-5e");
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(result.merged).toBe(0);
  });

  it("merges conflicting entities via AI", async () => {
    const io = mockIO({
      "/home/systems/d-d-5e/drafts/characters/goblin.md": "# Goblin\n\nNew version.",
      "/home/systems/d-d-5e/entities/characters/goblin.md": "# Goblin\n\nOld version.",
    });

    const result = await runMerge(mockProvider, io, "/home", "d-d-5e");
    expect(result.merged).toBe(1);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);

    // Check merged content was written
    expect(io.files["/home/systems/d-d-5e/entities/characters/goblin.md"]).toContain("Merged");
  });
});
