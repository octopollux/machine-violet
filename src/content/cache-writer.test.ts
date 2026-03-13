import type { FileIO } from "../agents/scene-manager.js";
import type { IngestJob, ChunkExtractionResult } from "./types.js";
import { writeChunkPages, writeBatchResults } from "./cache-writer.js";
import { createJob } from "./job-manager.js";
import type { PdfChunk } from "./types.js";
import { norm } from "../utils/paths.js";

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
    async mkdir(_path: string) { /* no-op */ },
    async exists(path: string) {
      return files[norm(path)] !== undefined;
    },
    async listDir(_path: string) { return []; },
  };
}

function makeTestJob(): IngestJob {
  const chunks: PdfChunk[] = [
    { index: 0, startPage: 1, endPage: 30, pdfBase64: "" },
  ];
  return createJob("TestCol", "TestBook", "/test.pdf", 30, chunks);
}

describe("writeChunkPages", () => {
  it("writes individual page files", async () => {
    const io = mockFileIO();
    const job = makeTestJob();

    const result: ChunkExtractionResult = {
      customId: "test:chunk-0",
      pages: [
        { pageNumber: 1, text: "Page one content" },
        { pageNumber: 2, text: "Page two content" },
        { pageNumber: 3, text: "Page three content" },
      ],
    };

    const written = await writeChunkPages(io, "/home", job, result);

    expect(written).toBe(3);
    const page1Path = norm("/home/ingest/cache/testcol/testbook/pages/0001.md");
    expect(io.files[page1Path]).toBe("Page one content");
    const page2Path = norm("/home/ingest/cache/testcol/testbook/pages/0002.md");
    expect(io.files[page2Path]).toBe("Page two content");
  });

  it("returns 0 for empty results", async () => {
    const io = mockFileIO();
    const job = makeTestJob();

    const result: ChunkExtractionResult = {
      customId: "test:chunk-0",
      error: "API error",
    };

    const written = await writeChunkPages(io, "/home", job, result);
    expect(written).toBe(0);
  });
});

describe("writeBatchResults", () => {
  it("writes pages from successful chunks and counts errors", async () => {
    const io = mockFileIO();
    const job = makeTestJob();

    const results: ChunkExtractionResult[] = [
      {
        customId: "test:chunk-0",
        pages: [
          { pageNumber: 1, text: "Content 1" },
          { pageNumber: 2, text: "Content 2" },
        ],
      },
      {
        customId: "test:chunk-1",
        error: "Request expired",
      },
    ];

    const summary = await writeBatchResults(io, "/home", job, results);

    expect(summary.pagesWritten).toBe(2);
    expect(summary.chunksErrored).toBe(1);
  });
});
