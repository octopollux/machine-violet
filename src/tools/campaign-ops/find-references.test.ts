import { describe, it, expect, vi } from "vitest";
import type { FileIO } from "../../agents/scene-manager.js";
import { findReferences } from "./find-references.js";

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

describe("findReferences", () => {
  it("finds wikilinks pointing to a target entity", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael\n**Type:** PC",
        "/camp/campaign/log.md": "Met [Kael](../characters/kael.md) at the tavern.",
        "/camp/campaign/scenes/001-tavern/transcript.md":
          "**DM:** [Kael](../../../characters/kael.md) enters.\n[Goblin](../../../characters/goblin.md) attacks.",
      },
      {
        "/camp/characters": ["kael.md"],
        "/camp/campaign/scenes": ["001-tavern"],
      },
    );

    const result = await findReferences("/camp", fio, "characters/kael.md");
    expect(result.target).toBe("characters/kael.md");
    expect(result.references).toHaveLength(2);

    const files = result.references.map((r) => r.file);
    expect(files).toContain("campaign/log.md");
    expect(files).toContain("campaign/scenes/001-tavern/transcript.md");

    const logRef = result.references.find((r) => r.file === "campaign/log.md")!;
    expect(logRef.display).toBe("Kael");
    expect(logRef.line).toBe(1);
  });

  it("returns empty references when no links point to target", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael",
        "/camp/characters/goblin.md": "# Goblin",
      },
      {
        "/camp/characters": ["kael.md", "goblin.md"],
      },
    );

    const result = await findReferences("/camp", fio, "characters/nobody.md");
    expect(result.references).toHaveLength(0);
  });

  it("reports total files scanned", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael",
        "/camp/factions/guild.md": "# Guild\nLed by [Kael](../characters/kael.md).",
      },
      {
        "/camp/characters": ["kael.md"],
        "/camp/factions": ["guild.md"],
      },
    );

    const result = await findReferences("/camp", fio, "characters/kael.md");
    expect(result.totalFiles).toBe(2);
    expect(result.references).toHaveLength(1);
    expect(result.references[0].file).toBe("factions/guild.md");
  });

  it("finds multiple references in the same file", async () => {
    const fio = mockFileIO(
      {
        "/camp/campaign/log.md":
          "[Kael](../characters/kael.md) fought bravely.\nLater, [Kael](../characters/kael.md) rested.",
      },
      {},
    );

    const result = await findReferences("/camp", fio, "characters/kael.md");
    expect(result.references).toHaveLength(2);
    expect(result.references[0].line).toBe(1);
    expect(result.references[1].line).toBe(2);
  });
});
