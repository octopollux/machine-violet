import type { FileIO } from "../agents/scene-manager.js";
import type { PdfChunk } from "./types.js";
import {
  slugify,
  createJob,
  saveJob,
  loadJob,
  saveCollectionManifest,
  listCollections,
  updateChunkStatus,
  recomputeJobStatus,
  ingestPaths,
} from "./job-manager.js";
import { norm } from "../utils/paths.js";

/** In-memory FileIO mock. */
function mockFileIO(): FileIO & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    async readFile(path: string) {
      const content = files[norm(path)];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async writeFile(path: string, content: string) {
      files[norm(path)] = content;
    },
    async appendFile(path: string, content: string) {
      files[norm(path)] = (files[norm(path)] ?? "") + content;
    },
    async mkdir(_path: string) {
      // no-op in memory
    },
    async exists(path: string) {
      // Check for exact file or any file under this path (directory check)
      const n = norm(path);
      if (files[n] !== undefined) return true;
      const prefix = n.endsWith("/") ? n : n + "/";
      return Object.keys(files).some((k) => k.startsWith(prefix));
    },
    async listDir(path: string) {
      const n = norm(path);
      const prefix = n.endsWith("/") ? n : n + "/";
      const entries = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first) entries.add(first);
        }
      }
      return [...entries];
    },
  };
}

describe("slugify", () => {
  it("converts to lowercase kebab-case", () => {
    expect(slugify("D&D 5e")).toBe("d-d-5e");
    expect(slugify("Monster Manual")).toBe("monster-manual");
    expect(slugify("  Spaces  ")).toBe("spaces");
  });
});

describe("createJob", () => {
  it("creates a job with correct structure", () => {
    const chunks: PdfChunk[] = [
      { index: 0, startPage: 1, endPage: 30, pdfBase64: "" },
      { index: 1, startPage: 31, endPage: 45, pdfBase64: "" },
    ];

    const job = createJob("D&D 5e", "Monster Manual", "/books/mm.pdf", 45, chunks);

    expect(job.collection).toBe("D&D 5e");
    expect(job.collectionSlug).toBe("d-d-5e");
    expect(job.name).toBe("D&D 5e — Monster Manual");
    expect(job.sourceFile).toBe("/books/mm.pdf");
    expect(job.totalPages).toBe(45);
    expect(job.chunks).toHaveLength(2);
    expect(job.chunks[0].status).toBe("pending");
    expect(job.status).toBe("pending");
    expect(job.id).toBeTruthy();
  });
});

describe("saveJob / loadJob", () => {
  it("round-trips a job through JSON", async () => {
    const io = mockFileIO();
    const chunks: PdfChunk[] = [
      { index: 0, startPage: 1, endPage: 30, pdfBase64: "" },
    ];
    const job = createJob("TestCol", "TestBook", "/test.pdf", 30, chunks);

    await saveJob(io, "/home", job);

    const loaded = await loadJob(io, "/home", "testcol", "testbook");
    expect(loaded.id).toBe(job.id);
    expect(loaded.name).toBe("TestCol — TestBook");
    expect(loaded.totalPages).toBe(30);
  });
});

describe("collection manifest", () => {
  it("creates and lists collections", async () => {
    const io = mockFileIO();

    await saveCollectionManifest(io, "/home", "D&D 5e", ["job1", "job2"]);
    const collections = await listCollections(io, "/home");

    expect(collections).toHaveLength(1);
    expect(collections[0].name).toBe("D&D 5e");
    expect(collections[0].jobIds).toEqual(["job1", "job2"]);
  });

  it("merges job IDs on update", async () => {
    const io = mockFileIO();

    await saveCollectionManifest(io, "/home", "D&D 5e", ["job1"]);
    await saveCollectionManifest(io, "/home", "D&D 5e", ["job2", "job3"]);

    const collections = await listCollections(io, "/home");
    expect(collections[0].jobIds).toEqual(["job1", "job2", "job3"]);
  });
});

describe("updateChunkStatus / recomputeJobStatus", () => {
  function makeJob(chunkCount: number) {
    const chunks: PdfChunk[] = Array.from({ length: chunkCount }, (_, i) => ({
      index: i,
      startPage: i * 30 + 1,
      endPage: (i + 1) * 30,
      pdfBase64: "",
    }));
    return createJob("Test", "Book", "/test.pdf", chunkCount * 30, chunks);
  }

  it("marks job complete when all chunks succeed", () => {
    const job = makeJob(3);
    for (let i = 0; i < 3; i++) {
      updateChunkStatus(job, i, "succeeded");
    }
    recomputeJobStatus(job);

    expect(job.status).toBe("complete");
    expect(job.pagesCompleted).toBe(90);
    expect(job.pagesFailed).toEqual([]);
  });

  it("marks job partial when some chunks fail", () => {
    const job = makeJob(3);
    updateChunkStatus(job, 0, "succeeded");
    updateChunkStatus(job, 1, "errored", "API error");
    updateChunkStatus(job, 2, "succeeded");
    recomputeJobStatus(job);

    expect(job.status).toBe("partial");
    expect(job.pagesCompleted).toBe(60);
    expect(job.pagesFailed).toHaveLength(30);
  });

  it("marks job failed when all chunks fail", () => {
    const job = makeJob(2);
    updateChunkStatus(job, 0, "errored", "fail");
    updateChunkStatus(job, 1, "canceled");
    recomputeJobStatus(job);

    expect(job.status).toBe("failed");
    expect(job.pagesCompleted).toBe(0);
    expect(job.pagesFailed).toHaveLength(60);
  });

  it("marks job processing when some chunks are submitted", () => {
    const job = makeJob(3);
    updateChunkStatus(job, 0, "succeeded");
    updateChunkStatus(job, 1, "submitted");
    // chunk 2 still pending
    recomputeJobStatus(job);

    expect(job.status).toBe("processing");
  });
});

describe("ingestPaths", () => {
  it("generates consistent paths", () => {
    const paths = ingestPaths("/home/.machine-violet");

    expect(norm(paths.jobFile("d-d-5e", "monster-manual")))
      .toBe("/home/.machine-violet/ingest/jobs/d-d-5e/monster-manual.json");
    expect(norm(paths.pageFile("d-d-5e", "monster-manual", 42)))
      .toBe("/home/.machine-violet/ingest/cache/d-d-5e/monster-manual/pages/0042.md");
  });
});
