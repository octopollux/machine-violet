/**
 * Local PDF text extraction — no AI, no API calls.
 *
 * Uses pdf-parse (built on Mozilla's pdf.js) to extract embedded text
 * layers from PDF pages. This is a mechanical operation — it reads the
 * text that's already in the PDF, like copy-paste.
 *
 * For PDFs with embedded text (most commercial RPG sourcebooks), this
 * produces clean, structured text per page. Image-only/scanned pages
 * will yield empty strings and can be flagged for future OCR support.
 */

import { PDFParse } from "pdf-parse";
import { readFile } from "node:fs/promises";
import type { PageExtractionResult } from "./types.js";

export interface ExtractionResult {
  /** Per-page extracted text. */
  pages: PageExtractionResult[];
  /** Total pages in the PDF. */
  totalPages: number;
  /** Pages that yielded no text (possible image-only pages). */
  emptyPages: number[];
}

/**
 * Extract text from all pages of a PDF file.
 *
 * @param filePath - Absolute path to the PDF.
 * @returns Per-page text extraction results.
 */
export async function extractTextFromPdf(filePath: string): Promise<ExtractionResult> {
  const bytes = await readFile(filePath);
  const parser = new PDFParse({ data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  const textResult = await parser.getText();

  const pages: PageExtractionResult[] = [];
  const emptyPages: number[] = [];

  for (const page of textResult.pages) {
    const text = page.text.trim();
    pages.push({ pageNumber: page.num, text });
    if (text.length === 0) {
      emptyPages.push(page.num);
    }
  }

  await parser.destroy();

  return {
    pages,
    totalPages: textResult.total,
    emptyPages,
  };
}
