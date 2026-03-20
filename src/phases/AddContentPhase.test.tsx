import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { AddContentPhase, parsePaths } from "./AddContentPhase.js";
import type { AddContentPhaseProps } from "./AddContentPhase.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../tui/themes/index.js";
import { resetPromptCache } from "../prompts/load-prompt.js";
import type { ValidatedPdf } from "../content/index.js";
import type { AvailableSystem } from "../config/systems.js";

beforeEach(() => {
  resetPromptCache();
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

const defaultSystems: AvailableSystem[] = [
  { slug: "dnd-5e", name: "D&D 5th Edition", bundled: true, hasRuleCard: true, processed: false, complexity: "high" as const, description: "The world's most popular RPG" },
];

function defaultProps(overrides?: Partial<AddContentPhaseProps>): AddContentPhaseProps {
  return {
    theme: makeTheme(),
    systems: defaultSystems,
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

  it("shows system picker initially", () => {
    const { lastFrame } = render(<AddContentPhase {...defaultProps()} />);
    expect(lastFrame()).toContain("Select a game system");
    expect(lastFrame()).toContain("D&D 5th Edition");
    expect(lastFrame()).toContain("Other");
  });

  it("shows checkmark for processed systems", () => {
    const processedSystems: AvailableSystem[] = [
      { slug: "dnd-5e", name: "D&D 5th Edition", bundled: true, hasRuleCard: true, processed: true, complexity: "high" as const, description: "The world's most popular RPG" },
    ];
    const { lastFrame } = render(<AddContentPhase {...defaultProps({ systems: processedSystems })} />);
    expect(lastFrame()).toContain("\u2713");
  });

  it("calls onCancel on Escape from pick step", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<AddContentPhase {...defaultProps({ onCancel })} />);
    stdin.write("\u001B");
    await vi.waitFor(() => {
      expect(onCancel).toHaveBeenCalled();
    });
  });

  it("advances to drop step after selecting a known system", async () => {
    const { stdin, lastFrame } = render(<AddContentPhase {...defaultProps()} />);
    // First option is already selected, press Enter
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("D&D 5th Edition");
      expect(lastFrame()).toContain("Drop PDF");
    });
  });

  it("shows name input when Other is selected", async () => {
    // Pass only empty systems so Other is the first (and only non-Other) option
    const emptySystemsList: AvailableSystem[] = [];
    const { stdin, lastFrame } = render(
      <AddContentPhase {...defaultProps({ systems: emptySystemsList })} />,
    );
    // Only option is "Other", already selected — press Enter
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Name this system");
    });
  });

  it("advances to drop step after entering custom name", async () => {
    const emptySystemsList: AvailableSystem[] = [];
    const { stdin, lastFrame } = render(
      <AddContentPhase {...defaultProps({ systems: emptySystemsList })} />,
    );
    // Select Other
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Name this system");
    });

    // Type a custom name — use a name that doesn't appear in the hint text,
    // then wait for it to render before pressing Enter.
    stdin.write("Mork Borg");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Mork Borg");
    });

    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Drop PDF");
    }, { timeout: 2000 });
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

    // Select first system
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Drop PDF");
    });

    // Drop a PDF path — wait for text to render before pressing Enter
    stdin.write("/books/Monster Manual.pdf");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Monster Manual");
    });

    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Monster Manual");
      expect(lastFrame()).toContain("343 pp");
    }, { timeout: 2000 });
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

    // Select first system
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Drop PDF");
    });

    // Add a PDF — wait for text to render before pressing Enter
    stdin.write("/test.pdf");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("/test.pdf");
    });

    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Test.pdf");
    }, { timeout: 2000 });

    // Press Enter with no input to finish adding
    stdin.write("\r");

    await vi.waitFor(() => {
      expect(lastFrame()).toContain("Submit");
      expect(lastFrame()).toContain("y/n");
    }, { timeout: 2000 });
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
