import {
  createPipelineState,
  loadPipelineState,
  savePipelineState,
  advanceStage,
  hasReachedStage,
} from "./processing-state.js";
import type { FileIO } from "../agents/scene-manager.js";
import type { PipelineState } from "./processing-types.js";

/** In-memory FileIO mock. */
function mockIO(): FileIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    readFile: vi.fn(async (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    }),
    writeFile: vi.fn(async (p: string, c: string) => { files[p] = c; }),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => p in files),
    listDir: vi.fn(async () => []),
  };
}

describe("createPipelineState", () => {
  it("creates state starting at classifier", () => {
    const state = createPipelineState("d-d-5e");
    expect(state.collectionSlug).toBe("d-d-5e");
    expect(state.currentStage).toBe("classifier");
    expect(state.stageData).toEqual({});
    expect(state.batchIds).toEqual([]);
  });
});

describe("save and load pipeline state", () => {
  it("round-trips through FileIO", async () => {
    const io = mockIO();
    const state = createPipelineState("d-d-5e");

    await savePipelineState(io, "/home", state);
    const loaded = await loadPipelineState(io, "/home", "d-d-5e");

    expect(loaded).not.toBeNull();
    expect(loaded!.collectionSlug).toBe("d-d-5e");
    expect(loaded!.currentStage).toBe("classifier");
  });

  it("returns null when no state file exists", async () => {
    const io = mockIO();
    const loaded = await loadPipelineState(io, "/home", "nonexistent");
    expect(loaded).toBeNull();
  });
});

describe("advanceStage", () => {
  it("advances through all stages in order", () => {
    const state = createPipelineState("test");
    expect(advanceStage(state)).toBe("extractors");
    expect(advanceStage(state)).toBe("merge");
    expect(advanceStage(state)).toBe("index");
    expect(advanceStage(state)).toBe("rule-card");
    expect(advanceStage(state)).toBe("complete");
  });

  it("throws when trying to advance past complete", () => {
    const state = createPipelineState("test");
    state.currentStage = "complete";
    expect(() => advanceStage(state)).toThrow("Cannot advance past stage");
  });
});

describe("hasReachedStage", () => {
  it("returns true for current and earlier stages", () => {
    const state: PipelineState = {
      collectionSlug: "test",
      currentStage: "merge",
      updatedAt: "",
      stageData: {},
      batchIds: [],
    };

    expect(hasReachedStage(state, "classifier")).toBe(true);
    expect(hasReachedStage(state, "extractors")).toBe(true);
    expect(hasReachedStage(state, "merge")).toBe(true);
    expect(hasReachedStage(state, "index")).toBe(false);
    expect(hasReachedStage(state, "rule-card")).toBe(false);
  });
});
