import { describe, it, expect, vi } from "vitest";
import type { FileIO } from "../../agents/scene-manager.js";
import { walkCampaignFiles } from "./walk-campaign.js";

function mockFileIO(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
): FileIO {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => p in files || p in dirs),
    listDir: vi.fn(async (p: string) => {
      if (p in dirs) return dirs[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    deleteFile: vi.fn(async () => {}),
  };
}

describe("walkCampaignFiles", () => {
  it("walks character files", async () => {
    const fio = mockFileIO(
      { "/camp/characters/kael.md": "# Kael" },
      { "/camp/characters": ["kael.md"] },
    );
    const result = await walkCampaignFiles("/camp", fio);
    expect(result).toHaveLength(1);
    expect(result[0].relativePath).toBe("characters/kael.md");
    expect(result[0].content).toBe("# Kael");
  });

  it("walks multiple entity directories", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael",
        "/camp/factions/guild.md": "# Guild",
        "/camp/lore/history.md": "# History",
        "/camp/players/alice.md": "# Alice",
      },
      {
        "/camp/characters": ["kael.md"],
        "/camp/factions": ["guild.md"],
        "/camp/lore": ["history.md"],
        "/camp/players": ["alice.md"],
      },
    );
    const result = await walkCampaignFiles("/camp", fio);
    const paths = result.map((f) => f.relativePath).sort();
    expect(paths).toEqual([
      "characters/kael.md",
      "factions/guild.md",
      "lore/history.md",
      "players/alice.md",
    ]);
  });

  it("walks location subdirectories", async () => {
    const fio = mockFileIO(
      {
        "/camp/locations/tavern/index.md": "# Tavern",
        "/camp/locations/forest/index.md": "# Forest",
      },
      {
        "/camp/locations": ["tavern", "forest"],
        "/camp/locations/tavern": ["index.md"],
        "/camp/locations/forest": ["index.md"],
      },
    );
    const result = await walkCampaignFiles("/camp", fio);
    const paths = result.map((f) => f.relativePath).sort();
    expect(paths).toEqual([
      "locations/forest/index.md",
      "locations/tavern/index.md",
    ]);
  });

  it("walks campaign log (JSON)", async () => {
    const fio = mockFileIO(
      { "/camp/campaign/log.json": '{"campaignName":"Test","entries":[]}' },
      {},
    );
    const result = await walkCampaignFiles("/camp", fio);
    expect(result).toHaveLength(1);
    expect(result[0].relativePath).toBe("campaign/log.json");
  });

  it("falls back to legacy log.md when log.json missing", async () => {
    const fio = mockFileIO(
      { "/camp/campaign/log.md": "# Campaign Log" },
      {},
    );
    const result = await walkCampaignFiles("/camp", fio);
    expect(result).toHaveLength(1);
    expect(result[0].relativePath).toBe("campaign/log.md");
  });

  it("walks scene transcripts and dm-notes", async () => {
    const fio = mockFileIO(
      {
        "/camp/campaign/scenes/001-tavern/transcript.md": "scene 1 transcript",
        "/camp/campaign/scenes/001-tavern/dm-notes.md": "scene 1 notes",
        "/camp/campaign/scenes/002-forest/transcript.md": "scene 2 transcript",
      },
      {
        "/camp/campaign/scenes": ["001-tavern", "002-forest"],
      },
    );
    const result = await walkCampaignFiles("/camp", fio);
    const paths = result.map((f) => f.relativePath).sort();
    expect(paths).toEqual([
      "campaign/scenes/001-tavern/dm-notes.md",
      "campaign/scenes/001-tavern/transcript.md",
      "campaign/scenes/002-forest/transcript.md",
    ]);
  });

  it("walks session recaps", async () => {
    const fio = mockFileIO(
      { "/camp/campaign/session-recaps/session-01.md": "recap 1" },
      { "/camp/campaign/session-recaps": ["session-01.md"] },
    );
    const result = await walkCampaignFiles("/camp", fio);
    expect(result).toHaveLength(1);
    expect(result[0].relativePath).toBe("campaign/session-recaps/session-01.md");
  });

  it("skips missing directories gracefully", async () => {
    const fio = mockFileIO({}, {});
    const result = await walkCampaignFiles("/camp", fio);
    expect(result).toHaveLength(0);
  });

  it("skips non-md files in entity directories", async () => {
    const fio = mockFileIO(
      { "/camp/characters/kael.md": "# Kael" },
      { "/camp/characters": ["kael.md", "notes.txt", ".DS_Store"] },
    );
    const result = await walkCampaignFiles("/camp", fio);
    expect(result).toHaveLength(1);
    expect(result[0].relativePath).toBe("characters/kael.md");
  });
});
