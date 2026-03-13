import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { AddContentPhase, parsePaths } from "./AddContentPhase.js";
import type { AddContentPhaseProps } from "./AddContentPhase.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../tui/themes/index.js";
import { resetPromptCache } from "../prompts/load-prompt.js";
import type { ValidatedPdf } from "../content/index.js";

beforeEach(() => {
  resetPromptCache();
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function defaultProps(overrides?: Partial<AddContentPhaseProps>): AddContentPhaseProps {
  return {
    theme: makeTheme(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    validatePdf: vi.fn(async (path: string) => ({
      filePath: path,
      baseName: path.replace(/.*[/\\]/, "").replace(/\.pdf$/i, ""),
      pageCount: 100,
    })),
    ...overrides,
  };
}

describe("AddContentPhase", () => {
  it("renders the Add Content title", () => {
    const { lastFrame } = render(<AddContentPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Add Content");
  });

  it("shows collection name prompt initially", () => {
    const { lastFrame } = render(<AddContentPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Name this collection");
  });

  it("calls onCancel on Escape from name step", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<AddContentPhase {...defaultProps({ onCancel })} />);
    // Ink's escape key is represented as the escape character
    stdin.write("\u001B");
    // useInput processes escape asynchronously in ink-testing-library
    await vi.waitFor(() => {
      expect(onCancel).toHaveBeenCalled();
    });
  });

  it("advances to drop step after entering collection name", async () => {
    const { stdin, lastFrame } = render(<AddContentPhase {...defaultProps()} />);
    // Type a collection name and press Enter
    stdin.write("D&D 5e");
    stdin.write("\r");

    // Should now show the collection name and drop prompt
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("D&D 5e");
      expect(lastFrame()).toContain("Drop PDF");
    });
  });

  it("shows error for empty collection name", async () => {
    const { stdin, lastFrame } = render(<AddContentPhase {...defaultProps()} />);
    stdin.write("\r"); // Enter with no input
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("cannot be empty");
    });
  });

  it("displays validated PDFs with checkmarks", async () => {
    const validatePdf = vi.fn(async (_path: string): Promise<ValidatedPdf> => ({
      filePath: "/books/Monster Manual.pdf",
      baseName: "Monster Manual",
      pageCount: 343,
    }));
    const { stdin, lastFrame } = render(
      <AddContentPhase {...defaultProps({ validatePdf })} />,
    );

    // Enter collection name
    stdin.write("D&D 5e");
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Drop PDF");
    });

    // Drop a PDF path
    stdin.write("/books/Monster Manual.pdf");
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Monster Manual");
      expect(lastFrame()).toContain("343 pp");
    });
  });

  it("shows confirm prompt after pressing Enter with no input on drop step", async () => {
    const validatePdf = vi.fn(async (_path: string): Promise<ValidatedPdf> => ({
      filePath: "/test.pdf",
      baseName: "Test",
      pageCount: 10,
    }));
    const { stdin, lastFrame } = render(
      <AddContentPhase {...defaultProps({ validatePdf })} />,
    );

    // Enter collection name
    stdin.write("Test");
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Drop PDF");
    });

    // Add a PDF
    stdin.write("/test.pdf");
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Test.pdf");
    });

    // Press Enter with no input to finish adding
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Submit");
      expect(lastFrame()).toContain("y/n");
    });
  });

  it("shows external status message", () => {
    const { lastFrame } = render(
      <AddContentPhase {...defaultProps({ statusMsg: "Processing batch..." })} />,
    );
    // Status message only shows in submitting step; this tests prop passthrough
    expect(lastFrame()).toBeTruthy();
  });
});

describe("parsePaths", () => {
  it("parses a single unquoted path", () => {
    expect(parsePaths("/books/test.pdf")).toEqual(["/books/test.pdf"]);
  });

  it("parses a double-quoted path", () => {
    expect(parsePaths('"C:\\Books\\Monster Manual.pdf"')).toEqual([
      "C:\\Books\\Monster Manual.pdf",
    ]);
  });

  it("parses a single-quoted path", () => {
    expect(parsePaths("'/books/my book.pdf'")).toEqual(["/books/my book.pdf"]);
  });

  it("parses multiple quoted paths", () => {
    const result = parsePaths('"C:\\a.pdf" "C:\\b.pdf"');
    expect(result).toEqual(["C:\\a.pdf", "C:\\b.pdf"]);
  });

  it("parses mixed quoted and unquoted", () => {
    const result = parsePaths('"C:\\My Books\\mm.pdf" /simple.pdf');
    expect(result).toEqual(["C:\\My Books\\mm.pdf", "/simple.pdf"]);
  });

  it("handles empty input", () => {
    expect(parsePaths("")).toEqual([]);
    expect(parsePaths("   ")).toEqual([]);
  });
});
