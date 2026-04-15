import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pdfLibAvailable = false;
try {
  await import("pdf-lib");
  pdfLibAvailable = true;
} catch {
  // pdf-lib is optional — tests will be skipped
}

// Lazily imported — pdf-split.ts has a top-level pdf-lib import
const pdfSplit = pdfLibAvailable
  ? await import("./pdf-split.js")
  : (undefined as unknown as typeof import("./pdf-split.js"));

/** Create a minimal PDF with the given number of blank pages. */
async function createTestPdf(pageCount: number): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([200, 200]);
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

// PDF processing and filesystem I/O have been flaky in CI under parallel workers
describe.skipIf(!pdfLibAvailable)("getPdfInfo", { retry: 2 }, () => {
  let tempDir: string;
  let pdfPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mv-test-"));
    pdfPath = join(tempDir, "Test Book.pdf");
  });

  it("returns page count and base name", async () => {
    const pdf = await createTestPdf(10);
    await writeFile(pdfPath, pdf);

    const info = await pdfSplit.getPdfInfo(pdfPath);
    expect(info.pageCount).toBe(10);
    expect(info.baseName).toBe("Test Book");
  });
});

describe.skipIf(!pdfLibAvailable)("splitPdf", { retry: 2 }, () => {
  let tempDir: string;
  let pdfPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mv-test-"));
    pdfPath = join(tempDir, "test.pdf");
  });

  it("returns a single chunk for PDFs smaller than chunk size", async () => {
    const pdf = await createTestPdf(5);
    await writeFile(pdfPath, pdf);

    const chunks = await pdfSplit.splitPdf(pdfPath, 30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].startPage).toBe(1);
    expect(chunks[0].endPage).toBe(5);
    expect(chunks[0].pdfBase64).toBeTruthy();
  });

  it("splits into correct number of chunks", async () => {
    const pdf = await createTestPdf(75);
    await writeFile(pdfPath, pdf);

    const chunks = await pdfSplit.splitPdf(pdfPath, 30);
    expect(chunks).toHaveLength(3);

    expect(chunks[0].startPage).toBe(1);
    expect(chunks[0].endPage).toBe(30);

    expect(chunks[1].startPage).toBe(31);
    expect(chunks[1].endPage).toBe(60);

    expect(chunks[2].startPage).toBe(61);
    expect(chunks[2].endPage).toBe(75);
  });

  it("produces valid PDF chunks", async () => {
    const pdf = await createTestPdf(45);
    await writeFile(pdfPath, pdf);

    const chunks = await pdfSplit.splitPdf(pdfPath, 30);
    expect(chunks).toHaveLength(2);

    // Verify each chunk is a valid PDF by loading it
    const { PDFDocument } = await import("pdf-lib");
    for (const chunk of chunks) {
      const bytes = Buffer.from(chunk.pdfBase64, "base64");
      const doc = await PDFDocument.load(bytes);
      const expectedPages = chunk.endPage - chunk.startPage + 1;
      expect(doc.getPageCount()).toBe(expectedPages);
    }
  });

  it("handles exact multiple of chunk size", async () => {
    const pdf = await createTestPdf(60);
    await writeFile(pdfPath, pdf);

    const chunks = await pdfSplit.splitPdf(pdfPath, 30);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].endPage).toBe(30);
    expect(chunks[1].startPage).toBe(31);
    expect(chunks[1].endPage).toBe(60);
  });

  it("default chunk size is 30", () => {
    expect(pdfSplit.DEFAULT_CHUNK_SIZE).toBe(30);
  });
});
