import { describe, it, expect, vi } from "vitest";
import type { FileIO } from "../../agents/scene-manager.js";
import { renameEntity, rewriteLinks } from "./rename-entity.js";

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

describe("rewriteLinks", () => {
  it("rewrites matching link targets", () => {
    const content = "Met [Kael](../characters/kael.md) at the tavern.";
    const result = rewriteLinks(
      content,
      "campaign/log.md",
      "characters/kael.md",
      "characters/kael-the-ranger.md",
    );
    expect(result.content).toBe("Met [Kael](../characters/kael-the-ranger.md) at the tavern.");
    expect(result.count).toBe(1);
  });

  it("does not rewrite non-matching links", () => {
    const content = "Met [Goblin](../characters/goblin.md) in battle.";
    const result = rewriteLinks(
      content,
      "campaign/log.md",
      "characters/kael.md",
      "characters/kael-the-ranger.md",
    );
    expect(result.content).toBe(content);
    expect(result.count).toBe(0);
  });

  it("rewrites multiple links on different lines", () => {
    const content =
      "[Kael](../characters/kael.md) fought bravely.\n[Kael](../characters/kael.md) rested.";
    const result = rewriteLinks(
      content,
      "campaign/log.md",
      "characters/kael.md",
      "characters/kael-the-ranger.md",
    );
    expect(result.content).toContain("kael-the-ranger.md");
    expect(result.count).toBe(2);
    expect(result.content).not.toContain("(../characters/kael.md)");
  });

  it("rewrites deep relative paths correctly", () => {
    const content = "[Kael](../../../characters/kael.md) enters the scene.";
    const result = rewriteLinks(
      content,
      "campaign/scenes/001-tavern/transcript.md",
      "characters/kael.md",
      "characters/kael-the-ranger.md",
    );
    expect(result.content).toBe(
      "[Kael](../../../characters/kael-the-ranger.md) enters the scene.",
    );
    expect(result.count).toBe(1);
  });
});

describe("renameEntity", () => {
  it("throws if source file does not exist", async () => {
    const fio = mockFileIO({}, {});
    await expect(
      renameEntity("/camp", fio, "characters/ghost.md", "characters/phantom.md", false),
    ).rejects.toThrow("Source file does not exist");
  });

  it("throws if destination file already exists", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael",
        "/camp/characters/duplicate.md": "# Dup",
      },
    );
    await expect(
      renameEntity("/camp", fio, "characters/kael.md", "characters/duplicate.md", false),
    ).rejects.toThrow("Destination file already exists");
  });

  it("dry-run reports changes without writing", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael\n**Type:** PC",
        "/camp/campaign/log.md": "Met [Kael](../characters/kael.md) at the tavern.",
      },
      {
        "/camp/characters": ["kael.md"],
      },
    );

    const result = await renameEntity(
      "/camp", fio, "characters/kael.md", "characters/kael-the-ranger.md", true,
    );

    expect(result.dryRun).toBe(true);
    expect(result.filesUpdated).toContain("campaign/log.md");
    expect(result.linksUpdated).toBe(1);
    expect(fio.writeFile).not.toHaveBeenCalled();
  });

  it("writes changes when not dry-run", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael\n**Type:** PC",
        "/camp/campaign/log.md": "Met [Kael](../characters/kael.md) at the tavern.",
      },
      {
        "/camp/characters": ["kael.md"],
      },
    );

    const result = await renameEntity(
      "/camp", fio, "characters/kael.md", "characters/kael-the-ranger.md", false,
    );

    expect(result.dryRun).toBe(false);
    expect(result.filesUpdated).toContain("campaign/log.md");
    expect(result.linksUpdated).toBe(1);

    // Should write updated log
    expect(fio.writeFile).toHaveBeenCalledWith(
      "/camp/campaign/log.md",
      "Met [Kael](../characters/kael-the-ranger.md) at the tavern.",
    );

    // Should write new entity file
    expect(fio.writeFile).toHaveBeenCalledWith(
      "/camp/characters/kael-the-ranger.md",
      "# Kael\n**Type:** PC",
    );

    // Should delete old entity file
    expect(fio.deleteFile).toHaveBeenCalledWith("/camp/characters/kael.md");
  });

  it("updates links from multiple files", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael",
        "/camp/campaign/log.md": "Met [Kael](../characters/kael.md).",
        "/camp/factions/guild.md": "Led by [Kael](../characters/kael.md).",
      },
      {
        "/camp/characters": ["kael.md"],
        "/camp/factions": ["guild.md"],
      },
    );

    const result = await renameEntity(
      "/camp", fio, "characters/kael.md", "characters/kael-ranger.md", true,
    );

    expect(result.filesUpdated.sort()).toEqual([
      "campaign/log.md",
      "factions/guild.md",
    ]);
    expect(result.linksUpdated).toBe(2);
  });
});
