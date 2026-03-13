import { loadModelConfig } from "../config/models.js";
import { resetContentPromptCache } from "./prompts/load-content-prompt.js";
import { buildIndex, runIndexer } from "./indexer.js";
import type { FileIO } from "../agents/scene-manager.js";
import type Anthropic from "@anthropic-ai/sdk";

const norm = (p: string) => p.replace(/\\/g, "/");

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetContentPromptCache();
});

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

describe("buildIndex", () => {
  it("builds TOC from entity files", async () => {
    const io = mockIO({
      "/home/ingest/processed/d-d-5e/entities/monsters/goblin.md": "# Goblin",
      "/home/ingest/processed/d-d-5e/entities/monsters/orc.md": "# Orc",
      "/home/ingest/processed/d-d-5e/entities/locations/waterdeep.md": "# Waterdeep",
    });

    const { content, result } = await buildIndex(io, "/home", "d-d-5e");

    expect(result.totalEntities).toBe(3);
    expect(result.categories).toContain("monsters");
    expect(result.categories).toContain("locations");
    expect(content).toContain("# Content Index");
    expect(content).toContain("## Monsters & Creatures");
    expect(content).toContain("[[Goblin]]");
    expect(content).toContain("[[Orc]]");
    expect(content).toContain("## Locations");
    expect(content).toContain("[[Waterdeep]]");
  });

  it("handles empty entities directory", async () => {
    const io = mockIO({});

    const { content, result } = await buildIndex(io, "/home", "d-d-5e");

    expect(result.totalEntities).toBe(0);
    expect(content).toContain("No entities found");
  });

  it("sorts entities alphabetically within category", async () => {
    const io = mockIO({
      "/home/ingest/processed/d-d-5e/entities/monsters/zombie.md": "",
      "/home/ingest/processed/d-d-5e/entities/monsters/ancient-dragon.md": "",
      "/home/ingest/processed/d-d-5e/entities/monsters/beholder.md": "",
    });

    const { content } = await buildIndex(io, "/home", "d-d-5e");
    const lines = content.split("\n").filter((l) => l.startsWith("- [["));

    // Should be alphabetical
    expect(lines[0]).toContain("Ancient Dragon");
    expect(lines[1]).toContain("Beholder");
    expect(lines[2]).toContain("Zombie");
  });
});

describe("runIndexer", () => {
  const mockClient = {
    messages: {
      create: vi.fn(async () => ({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: "# DM Cheat Sheet\n\nQuick reference content." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          inference_geo: null,
          server_tool_use: null,
          service_tier: null,
        },
      })),
    },
  } as unknown as Anthropic;

  it("writes index.md and cheat-sheet.md", async () => {
    const io = mockIO({
      "/home/ingest/processed/d-d-5e/entities/monsters/goblin.md": "# Goblin",
      "/home/ingest/processed/d-d-5e/entities/rules/combat.md": "# Combat",
    });

    const result = await runIndexer(mockClient, io, "/home", "d-d-5e");

    expect(result.totalEntities).toBe(2);

    // Index was written
    const indexPath = "/home/ingest/processed/d-d-5e/index.md";
    expect(io.files[indexPath]).toContain("# Content Index");

    // Cheat sheet was written
    const cheatPath = "/home/ingest/processed/d-d-5e/cheat-sheet.md";
    expect(io.files[cheatPath]).toContain("Cheat Sheet");
  });

  it("skips cheat sheet when no entities", async () => {
    const noCallClient = {
      messages: {
        create: vi.fn(async () => { throw new Error("should not be called"); }),
      },
    } as unknown as Anthropic;

    const io = mockIO({});

    const result = await runIndexer(noCallClient, io, "/home", "d-d-5e");

    expect(result.totalEntities).toBe(0);
    // Cheat sheet should not be written
    expect(noCallClient.messages.create).not.toHaveBeenCalled();
  });
});
