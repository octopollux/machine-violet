import { describe, it, expect } from "vitest";
import { writeDebugDump } from "./debug-dump.js";
import type { FileIO } from "../../agents/scene-manager.js";
import { norm } from "../../utils/paths.js";

function createMockFileIO(): FileIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    async readFile(path: string) {
      const p = norm(path);
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
    async writeFile(path: string, content: string) {
      files[norm(path)] = content;
    },
    async appendFile(path: string, content: string) {
      const p = norm(path);
      files[p] = (files[p] ?? "") + content;
    },
    async mkdir(_path: string) { /* no-op */ },
    async exists(path: string) {
      return norm(path) in files;
    },
    async listDir(_path: string) {
      return [];
    },
  };
}

describe("writeDebugDump", () => {
  it("writes a crash dump file with all sections", async () => {
    const fio = createMockFileIO();
    const error = new Error("null startsWith");
    error.stack = "Error: null startsWith\n    at Foo.bar (src/foo.ts:10:5)";

    const result = await writeDebugDump("/camp", fio, {
      error,
      engineState: "dm_thinking",
      sceneNumber: 2,
      sceneSlug: "tavern",
      sessionNumber: 1,
      precis: "The party entered the tavern.",
      transcript: ["Player says hello.", "DM describes the room."],
      conversationSize: 3,
    });

    expect(result).toBeTruthy();
    expect(result).toContain(".debug");
    expect(result).toContain("crash-");

    // Find the written file
    const dumpFile = Object.entries(fio.files).find(([k]) => k.includes("crash-"));
    expect(dumpFile).toBeTruthy();

    const content = dumpFile![1];
    expect(content).toContain("=== DEBUG DUMP ===");
    expect(content).toContain("Engine State: dm_thinking");
    expect(content).toContain("Scene: 2 (tavern)");
    expect(content).toContain("Session: 1");
    expect(content).toContain("=== ERROR ===");
    expect(content).toContain("null startsWith");
    expect(content).toContain("at Foo.bar (src/foo.ts:10:5)");
    expect(content).toContain("=== PRECIS ===");
    expect(content).toContain("The party entered the tavern.");
    expect(content).toContain("=== SCENE TRANSCRIPT ===");
    expect(content).toContain("Player says hello.");
    expect(content).toContain("DM describes the room.");
    expect(content).toContain("=== CONVERSATION ===");
    expect(content).toContain("Active exchanges: 3");
  });

  it("creates .gitignore with .debug/ entry when none exists", async () => {
    const fio = createMockFileIO();
    const error = new Error("test");

    await writeDebugDump("/camp", fio, {
      error,
      engineState: "idle",
      sceneNumber: 1,
      sceneSlug: "opening",
      sessionNumber: 1,
      precis: "",
      transcript: [],
      conversationSize: 0,
    });

    const gitignore = fio.files[norm("/camp/.gitignore")];
    expect(gitignore).toContain(".debug/");
  });

  it("appends .debug/ to existing .gitignore", async () => {
    const fio = createMockFileIO();
    fio.files[norm("/camp/.gitignore")] = ".dev-mode/\n";
    const error = new Error("test");

    await writeDebugDump("/camp", fio, {
      error,
      engineState: "idle",
      sceneNumber: 1,
      sceneSlug: "opening",
      sessionNumber: 1,
      precis: "",
      transcript: [],
      conversationSize: 0,
    });

    const gitignore = fio.files[norm("/camp/.gitignore")];
    expect(gitignore).toContain(".dev-mode/");
    expect(gitignore).toContain(".debug/");
  });

  it("skips .gitignore update if .debug/ already present", async () => {
    const fio = createMockFileIO();
    fio.files[norm("/camp/.gitignore")] = ".debug/\n";
    const error = new Error("test");

    await writeDebugDump("/camp", fio, {
      error,
      engineState: "idle",
      sceneNumber: 1,
      sceneSlug: "opening",
      sessionNumber: 1,
      precis: "",
      transcript: [],
      conversationSize: 0,
    });

    // Should not duplicate
    const gitignore = fio.files[norm("/camp/.gitignore")];
    const matches = gitignore.match(/\.debug\//g);
    expect(matches?.length).toBe(1);
  });

  it("returns null if fileIO.writeFile throws", async () => {
    const fio = createMockFileIO();
    fio.writeFile = async () => { throw new Error("disk full"); };
    const error = new Error("test");

    const result = await writeDebugDump("/camp", fio, {
      error,
      engineState: "idle",
      sceneNumber: 1,
      sceneSlug: "opening",
      sessionNumber: 1,
      precis: "",
      transcript: [],
      conversationSize: 0,
    });

    expect(result).toBeNull();
  });

  it("omits precis section when precis is empty", async () => {
    const fio = createMockFileIO();
    const error = new Error("test");

    await writeDebugDump("/camp", fio, {
      error,
      engineState: "idle",
      sceneNumber: 1,
      sceneSlug: "opening",
      sessionNumber: 1,
      precis: "",
      transcript: [],
      conversationSize: 0,
    });

    const dumpFile = Object.entries(fio.files).find(([k]) => k.includes("crash-"));
    expect(dumpFile![1]).not.toContain("=== PRECIS ===");
  });
});
