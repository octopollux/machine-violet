/**
 * PDF splitting — takes a PDF file and splits it into chunks of N pages.
 *
 * Uses pdf-lib (pure TypeScript, zero native deps) for PDF manipulation.
 * Each chunk is a standalone PDF encoded as base64, ready to send to the
 * Claude API as a document content block.
 */

import { PDFDocument } from "pdf-lib";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { PdfChunk, PdfInfo } from "./types.js";

/** Default number of pages per chunk. */
export const DEFAULT_CHUNK_SIZE = 30;

/**
 * Read a PDF file and return basic info (page count, base name).
 * Does not split — use this for validation and UI display before committing.
 */
export async function getPdfInfo(filePath: string): Promise<PdfInfo> {
  const bytes = await readFile(filePath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const ext = extname(filePath);
  return {
    pageCount: doc.getPageCount(),
    baseName: basename(filePath, ext),
  };
}

/**
 * Split a PDF file into chunks of `chunkSize` pages.
 *
 * Each chunk is a new PDF document containing a contiguous range of pages,
 * serialized as base64. The Claude API accepts base64-encoded PDFs directly
 * as document content blocks.
 *
 * @param filePath - Absolute path to the source PDF.
 * @param chunkSize - Number of pages per chunk (default 30).
 * @returns Array of PdfChunk objects with page ranges and base64 data.
 */
export async function splitPdf(
  filePath: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<PdfChunk[]> {
  const bytes = await readFile(filePath);
  const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  const chunks: PdfChunk[] = [];

  for (let start = 0; start < totalPages; start += chunkSize) {
    const end = Math.min(start + chunkSize, totalPages);
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);

    const chunkDoc = await PDFDocument.create();
    const copiedPages = await chunkDoc.copyPages(srcDoc, pageIndices);
    for (const page of copiedPages) {
      chunkDoc.addPage(page);
    }

    const chunkBytes = await chunkDoc.save();
    const pdfBase64 = Buffer.from(chunkBytes).toString("base64");

    chunks.push({
      index: chunks.length,
      startPage: start + 1,       // 1-based
      endPage: end,               // 1-based, inclusive
      pdfBase64,
    });
  }

  return chunks;
}
