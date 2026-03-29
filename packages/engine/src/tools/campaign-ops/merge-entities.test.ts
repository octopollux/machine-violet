import { describe, it, expect, vi } from "vitest";
import type { FileIO } from "../../agents/scene-manager.js";
import { mergeEntities } from "./merge-entities.js";

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

describe("mergeEntities", () => {
  const winnerContent = [
    "# Kael",
    "**Type:** PC",
    "**Race:** Half-elf",
    "",
    "A brave ranger.",
    "",
    "## Changelog",
    "- Created in scene 001",
  ].join("\n");

  const loserContent = [
    "# Kael the Ranger",
    "**Type:** PC",
    "**Class:** Ranger",
    "**Homeland:** Silverglade",
    "",
    "Known for tracking skills.",
    "",
    "## Changelog",
    "- Mentioned in scene 002",
  ].join("\n");

  it("merges front matter — loser fills gaps in winner", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": winnerContent,
        "/camp/characters/kael-ranger.md": loserContent,
      },
      { "/camp/characters": ["kael.md", "kael-ranger.md"] },
    );

    const result = await mergeEntities(
      "/camp", fio, "characters/kael.md", "characters/kael-ranger.md", true,
    );

    expect(result.keysAdded).toContain("class");
    expect(result.keysAdded).toContain("homeland");
    expect(result.keysAdded).not.toContain("type"); // winner already has type
  });

  it("dry-run does not write files", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": winnerContent,
        "/camp/characters/kael-ranger.md": loserContent,
      },
      { "/camp/characters": ["kael.md", "kael-ranger.md"] },
    );

    await mergeEntities(
      "/camp", fio, "characters/kael.md", "characters/kael-ranger.md", true,
    );

    expect(fio.writeFile).not.toHaveBeenCalled();
    expect(fio.deleteFile).not.toHaveBeenCalled();
  });

  it("writes merged file and deletes loser when not dry-run", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": winnerContent,
        "/camp/characters/kael-ranger.md": loserContent,
      },
      { "/camp/characters": ["kael.md", "kael-ranger.md"] },
    );

    await mergeEntities(
      "/camp", fio, "characters/kael.md", "characters/kael-ranger.md", false,
    );

    // Winner should be written with merged content
    expect(fio.writeFile).toHaveBeenCalledWith(
      "/camp/characters/kael.md",
      expect.stringContaining("# Kael"),
    );
    // Merged content includes loser's class and homeland
    const writeCall = (fio.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "/camp/characters/kael.md",
    );
    expect(writeCall).toBeDefined();
    const mergedOutput = writeCall![1] as string;
    expect(mergedOutput).toContain("**Class:** Ranger");
    expect(mergedOutput).toContain("**Homeland:** Silverglade");
    expect(mergedOutput).toContain("**Race:** Half-elf");

    // Loser deleted
    expect(fio.deleteFile).toHaveBeenCalledWith("/camp/characters/kael-ranger.md");
  });

  it("repoints wikilinks from loser to winner", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael\n**Type:** PC",
        "/camp/characters/kael-dupe.md": "# Kael\n**Type:** PC",
        "/camp/campaign/log.md":
          "Met [Kael](../characters/kael-dupe.md) at the tavern.",
      },
      { "/camp/characters": ["kael.md", "kael-dupe.md"] },
    );

    const result = await mergeEntities(
      "/camp", fio, "characters/kael.md", "characters/kael-dupe.md", false,
    );

    expect(result.filesUpdated).toContain("campaign/log.md");
    expect(result.linksUpdated).toBe(1);

    // Log should now point to winner
    expect(fio.writeFile).toHaveBeenCalledWith(
      "/camp/campaign/log.md",
      "Met [Kael](../characters/kael.md) at the tavern.",
    );
  });

  it("concatenates changelogs with winner first", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": winnerContent,
        "/camp/characters/kael-ranger.md": loserContent,
      },
      { "/camp/characters": ["kael.md", "kael-ranger.md"] },
    );

    await mergeEntities(
      "/camp", fio, "characters/kael.md", "characters/kael-ranger.md", false,
    );

    const writeCall = (fio.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "/camp/characters/kael.md",
    );
    const mergedOutput = writeCall![1] as string;
    const changelogIdx = mergedOutput.indexOf("## Changelog");
    const changelogSection = mergedOutput.slice(changelogIdx);
    expect(changelogSection).toContain("- Created in scene 001");
    expect(changelogSection).toContain("- Mentioned in scene 002");
    // Winner changelog entry should come first
    expect(
      changelogSection.indexOf("Created in scene 001"),
    ).toBeLessThan(
      changelogSection.indexOf("Mentioned in scene 002"),
    );
  });

  it("appends loser body when different from winner", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": winnerContent,
        "/camp/characters/kael-ranger.md": loserContent,
      },
      { "/camp/characters": ["kael.md", "kael-ranger.md"] },
    );

    await mergeEntities(
      "/camp", fio, "characters/kael.md", "characters/kael-ranger.md", false,
    );

    const writeCall = (fio.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "/camp/characters/kael.md",
    );
    const mergedOutput = writeCall![1] as string;
    expect(mergedOutput).toContain("A brave ranger.");
    expect(mergedOutput).toContain("---");
    expect(mergedOutput).toContain("Known for tracking skills.");
  });

  it("does not duplicate body when same", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael\n**Type:** PC\n\nSame body.",
        "/camp/characters/kael-dupe.md": "# Kael\n**Type:** PC\n\nSame body.",
      },
      { "/camp/characters": ["kael.md", "kael-dupe.md"] },
    );

    await mergeEntities(
      "/camp", fio, "characters/kael.md", "characters/kael-dupe.md", false,
    );

    const writeCall = (fio.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "/camp/characters/kael.md",
    );
    const mergedOutput = writeCall![1] as string;
    expect(mergedOutput).not.toContain("---");
    // Body should appear once
    const occurrences = mergedOutput.split("Same body.").length - 1;
    expect(occurrences).toBe(1);
  });
});
