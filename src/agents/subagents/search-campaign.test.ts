import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSearchToolHandler } from "./search-campaign.js";
import type { CampaignFile } from "../../tools/campaign-ops/walk-campaign.js";
import type { FileIO } from "../scene-manager.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import { norm } from "../../utils/paths.js";

beforeEach(() => {
  resetPromptCache();
});

function mockFileIO(files: Record<string, string> = {}): FileIO {
  const store: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) store[norm(k)] = v;
  return {
    readFile: vi.fn(async (path: string) => {
      const p = norm(path);
      if (store[p]) return store[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    exists: vi.fn(async (path: string) => norm(path) in store),
    listDir: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
  };
}

const SAMPLE_FILES: CampaignFile[] = [
  {
    relativePath: "characters/kael.md",
    content: "# Kael\n\n**Type:** character\n**Class:** Ranger\n**Location:** [[Thornwood]]\n\nA half-elf ranger tracking the Shadow Guild.",
  },
  {
    relativePath: "characters/grimjaw.md",
    content: "# Grimjaw\n\n**Type:** character\n**Disposition:** hostile\n\nAn orc warlord threatening the eastern settlements.",
  },
  {
    relativePath: "locations/thornwood/index.md",
    content: "# Thornwood\n\n**Type:** location\n\nA dense forest east of the capital. Home to [[Kael]] and various forest creatures.",
  },
  {
    relativePath: "factions/shadow-guild.md",
    content: "# Shadow Guild\n\n**Type:** faction\n\nA secretive thieves' guild operating across the realm. [[Kael]] has been tracking them.",
  },
  {
    relativePath: "campaign/scenes/001-arrival/transcript.md",
    content: "## Scene 1: Arrival\n\n[[Kael]] arrived at [[Thornwood]] and met a mysterious stranger who mentioned the Shadow Guild.",
  },
  {
    relativePath: "campaign/session-recaps/session-1.md",
    content: "# Session 1 Recap\n\nThe party traveled through [[Thornwood]] and encountered [[Grimjaw]]'s scouts.",
  },
  {
    relativePath: "campaign/log.json",
    content: JSON.stringify({
      campaignName: "Test Campaign",
      entries: [{ sceneNumber: 1, title: "Arrival", full: "Party arrived at [[Thornwood]]", mini: "Arrived [[Thornwood]]" }],
    }),
  },
];

describe("buildSearchToolHandler", () => {
  describe("grep_campaign", () => {
    it("finds matches across all files", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", { pattern: "Kael" });

      expect(result.content).toContain("characters/kael.md");
      expect(result.content).toContain("locations/thornwood/index.md");
      expect(result.content).toContain("factions/shadow-guild.md");
    });

    it("is case-insensitive", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", { pattern: "kael" });

      expect(result.content).toContain("characters/kael.md");
    });

    it("filters by entity files", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", {
        pattern: "Kael",
        file_filter: "entities",
      });

      expect(result.content).toContain("characters/kael.md");
      expect(result.content).not.toContain("campaign/scenes");
    });

    it("filters by scenes", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", {
        pattern: "Shadow Guild",
        file_filter: "scenes",
      });

      expect(result.content).toContain("campaign/scenes/001-arrival");
      expect(result.content).not.toContain("factions/shadow-guild");
    });

    it("filters by recaps", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", {
        pattern: "Grimjaw",
        file_filter: "recaps",
      });

      expect(result.content).toContain("campaign/session-recaps/session-1.md");
      expect(result.content).not.toContain("characters/grimjaw.md");
    });

    it("filters by log", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", {
        pattern: "Thornwood",
        file_filter: "log",
      });

      expect(result.content).toContain("campaign/log.json");
      expect(result.content).not.toContain("characters/kael.md");
    });

    it("returns no matches message when nothing found", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", { pattern: "nonexistent-xyz" });

      expect(result.content).toBe("No matches found.");
    });

    it("truncates at 30 matches", async () => {
      // Create files with many matching lines
      const manyFiles: CampaignFile[] = Array.from({ length: 35 }, (_, i) => ({
        relativePath: `characters/char-${i}.md`,
        content: "match-this-pattern",
      }));
      const handler = buildSearchToolHandler(manyFiles, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", { pattern: "match-this-pattern" });

      expect(result.content).toContain("truncated at 30");
      // Count lines (excluding the truncation notice)
      const matchLines = result.content.split("\n").filter((l: string) => l.startsWith("characters/"));
      expect(matchLines).toHaveLength(30);
    });

    it("includes line numbers in results", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("grep_campaign", { pattern: "Ranger" });

      // "Ranger" appears on line 4 of kael.md
      expect(result.content).toMatch(/characters\/kael\.md:\d+:/);
    });
  });

  describe("read_campaign_file", () => {
    it("reads a file by relative path", async () => {
      const fio = mockFileIO({
        "/camp/characters/kael.md": "# Kael\nA ranger.",
      });
      const handler = buildSearchToolHandler(SAMPLE_FILES, fio, "/camp");
      const result = await handler("read_campaign_file", { path: "characters/kael.md" });

      expect(result.content).toBe("# Kael\nA ranger.");
    });

    it("returns error for missing files", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("read_campaign_file", { path: "characters/nobody.md" });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  describe("unknown tool", () => {
    it("returns error for unknown tool names", async () => {
      const handler = buildSearchToolHandler(SAMPLE_FILES, mockFileIO(), "/camp");
      const result = await handler("bad_tool", {});

      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Unknown tool");
    });
  });
});
