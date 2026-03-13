import { parsePageDelimiters, buildBatchRequests } from "./batch-client.js";
import { loadModelConfig } from "../config/models.js";
import type { PdfChunk } from "./types.js";

beforeEach(() => {
  loadModelConfig({ reset: true });
});

describe("parsePageDelimiters", () => {
  it("parses standard page delimiters", () => {
    const text = `---PAGE 1---
# Introduction
Welcome to the game.

---PAGE 2---
# Chapter One
The adventure begins.

---PAGE 3---
# Chapter Two
Deeper into the dungeon.`;

    const pages = parsePageDelimiters(text, "job1_chunk-0");
    expect(pages).toHaveLength(3);
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[0].text).toContain("Introduction");
    expect(pages[1].pageNumber).toBe(2);
    expect(pages[1].text).toContain("Chapter One");
    expect(pages[2].pageNumber).toBe(3);
    expect(pages[2].text).toContain("Chapter Two");
  });

  it("handles text with no delimiters as a single page", () => {
    const text = "Some extracted text without any page markers.";
    const pages = parsePageDelimiters(text, "job1_chunk-0");

    expect(pages).toHaveLength(1);
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[0].text).toBe(text);
  });

  it("infers page number from chunk index when no delimiters found", () => {
    const text = "Some text from chunk 3.";
    const pages = parsePageDelimiters(text, "job1_chunk-3");

    expect(pages).toHaveLength(1);
    expect(pages[0].pageNumber).toBe(91); // chunk 3 * 30 + 1
  });

  it("handles extra whitespace around delimiters", () => {
    const text = `---PAGE  1---
First page content.

---PAGE  2---
Second page content.`;

    const pages = parsePageDelimiters(text, "job1_chunk-0");
    expect(pages).toHaveLength(2);
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[1].pageNumber).toBe(2);
  });

  it("handles non-sequential page numbers", () => {
    const text = `---PAGE 31---
Content of page 31.

---PAGE 32---
Content of page 32.`;

    const pages = parsePageDelimiters(text, "job1_chunk-1");
    expect(pages).toHaveLength(2);
    expect(pages[0].pageNumber).toBe(31);
    expect(pages[1].pageNumber).toBe(32);
  });
});

describe("buildBatchRequests", () => {
  it("creates one request per chunk with correct custom_id", () => {
    const chunks: PdfChunk[] = [
      { index: 0, startPage: 1, endPage: 30, pdfBase64: "AAAA" },
      { index: 1, startPage: 31, endPage: 60, pdfBase64: "BBBB" },
    ];

    const requests = buildBatchRequests("job-123", chunks);

    expect(requests).toHaveLength(2);
    expect(requests[0].custom_id).toBe("job-123_chunk-0");
    expect(requests[1].custom_id).toBe("job-123_chunk-1");
  });

  it("uses the small model tier", () => {
    const chunks: PdfChunk[] = [
      { index: 0, startPage: 1, endPage: 30, pdfBase64: "AAAA" },
    ];

    const requests = buildBatchRequests("job-123", chunks);
    expect(requests[0].params.model).toBe("claude-haiku-4-5-20251001");
  });

  it("includes PDF as document content block", () => {
    const chunks: PdfChunk[] = [
      { index: 0, startPage: 1, endPage: 30, pdfBase64: "AAAA" },
    ];

    const requests = buildBatchRequests("job-123", chunks);
    const content = requests[0].params.messages[0].content;

    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "AAAA",
      },
    });
    expect(blocks[1]).toMatchObject({ type: "text" });
  });
});
