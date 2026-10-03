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

describe("walkCampaignFiles narrative boundary",()=>{
  it("walks JSON log, rules, transcripts, scene notes and recaps",async()=>{
    const io=mockFileIO({"/camp/campaign/log.json":"[]","/camp/rules/core.md":"Rules","/camp/campaign/scenes/001-gate/transcript.md":"Transcript","/camp/campaign/scenes/001-gate/dm-notes.md":"Notes","/camp/campaign/session-recaps/session-001.md":"Recap"},{"/camp/rules":["core.md","asset.png"],"/camp/campaign/scenes":["001-gate"],"/camp/campaign/session-recaps":["session-001.md"]});
    expect((await walkCampaignFiles("/camp",io)).map(file=>file.relativePath).sort()).toEqual(["campaign/log.json","campaign/scenes/001-gate/dm-notes.md","campaign/scenes/001-gate/transcript.md","campaign/session-recaps/session-001.md","rules/core.md"]);
  });
  it("never scans old entity directories or a legacy log fallback",async()=>{
    const io=mockFileIO({"/camp/characters/bob.md":"Bob","/camp/locations/gate/index.md":"Gate","/camp/campaign/log.md":"Legacy log"},{"/camp/characters":["bob.md"],"/camp/locations":["gate"]});
    expect(await walkCampaignFiles("/camp",io)).toEqual([]);
    expect(io.readFile).not.toHaveBeenCalledWith("/camp/campaign/log.md");expect(io.listDir).not.toHaveBeenCalledWith("/camp/characters");
  });
  it("tolerates absent narrative files",async()=>{expect(await walkCampaignFiles("/camp",mockFileIO())).toEqual([]);});
});
