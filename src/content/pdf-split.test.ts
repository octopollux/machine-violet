import { PDFDocument } from "pdf-lib";
import { splitPdf, getPdfInfo, DEFAULT_CHUNK_SIZE } from "./pdf-split.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a minimal PDF with the given number of blank pages. */
async function createTestPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([200, 200]);
  }
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

// pdf-parse loads native pdf.js modules that can race under parallel workers
describe("getPdfInfo", { retry: 2 }, () => {
  let tempDir: string;
  let pdfPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mv-test-"));
    pdfPath = join(tempDir, "Test Book.pdf");
  });

  it("returns page count and base name", async () => {
    const pdf = await createTestPdf(10);
    await writeFile(pdfPath, pdf);

    const info = await getPdfInfo(pdfPath);
    expect(info.pageCount).toBe(10);
    expect(info.baseName).toBe("Test Book");
  });
});

describe("splitPdf", { retry: 2 }, () => {
  let tempDir: string;
  let pdfPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mv-test-"));
    pdfPath = join(tempDir, "test.pdf");
  });

  it("returns a single chunk for PDFs smaller than chunk size", async () => {
    const pdf = await createTestPdf(5);
    await writeFile(pdfPath, pdf);

    const chunks = await splitPdf(pdfPath, 30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].startPage).toBe(1);
    expect(chunks[0].endPage).toBe(5);
    expect(chunks[0].pdfBase64).toBeTruthy();
  });

  it("splits into correct number of chunks", async () => {
    const pdf = await createTestPdf(75);
    await writeFile(pdfPath, pdf);

    const chunks = await splitPdf(pdfPath, 30);
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

    const chunks = await splitPdf(pdfPath, 30);
    expect(chunks).toHaveLength(2);

    // Verify each chunk is a valid PDF by loading it
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

    const chunks = await splitPdf(pdfPath, 30);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].endPage).toBe(30);
    expect(chunks[1].startPage).toBe(31);
    expect(chunks[1].endPage).toBe(60);
  });

  it("default chunk size is 30", () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(30);
  });
});
