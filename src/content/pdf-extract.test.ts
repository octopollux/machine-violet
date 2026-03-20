import { PDFDocument } from "pdf-lib";
import { extractTextFromPdf } from "./pdf-extract.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a PDF with pages containing the given text strings. */
async function createTextPdf(pageTexts: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");

  for (const text of pageTexts) {
    const page = doc.addPage([400, 400]);
    if (text.length > 0) {
      page.drawText(text, { x: 50, y: 350, font, size: 12 });
    }
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

// pdf-parse loads native pdf.js modules that can race under parallel workers
describe("extractTextFromPdf", { retry: 2 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mv-extract-"));
  });

  it("extracts text from pages", async () => {
    const pdfPath = join(tempDir, "test.pdf");
    const pdf = await createTextPdf(["Hello World", "Page Two Content"]);
    await writeFile(pdfPath, pdf);

    const result = await extractTextFromPdf(pdfPath);

    expect(result.totalPages).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].pageNumber).toBe(1);
    expect(result.pages[0].text).toContain("Hello World");
    expect(result.pages[1].pageNumber).toBe(2);
    expect(result.pages[1].text).toContain("Page Two Content");
  });

  it("reports empty pages", async () => {
    const pdfPath = join(tempDir, "empty.pdf");
    const pdf = await createTextPdf(["Has text", "", "Also has text"]);
    await writeFile(pdfPath, pdf);

    const result = await extractTextFromPdf(pdfPath);

    expect(result.totalPages).toBe(3);
    expect(result.emptyPages).toContain(2);
    expect(result.emptyPages).not.toContain(1);
    expect(result.emptyPages).not.toContain(3);
  });

  it("handles single-page PDF", async () => {
    const pdfPath = join(tempDir, "single.pdf");
    const pdf = await createTextPdf(["Only page"]);
    await writeFile(pdfPath, pdf);

    const result = await extractTextFromPdf(pdfPath);

    expect(result.totalPages).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toContain("Only page");
    expect(result.emptyPages).toEqual([]);
  });
});
