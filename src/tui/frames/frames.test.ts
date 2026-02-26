import { describe, it, expect } from "vitest";
import {
  STYLES,
  getStyle,
  styleForGenre,
  renderHorizontalFrame,
  renderVerticalFrame,
  renderContentLine,
  renderTopFrame,
  stringWidth,
  truncateToWidth,
} from "./index.js";

describe("styles data", () => {
  it("ships 6 styles", () => {
    expect(STYLES).toHaveLength(6);
  });

  it("all styles have all 4 variants", () => {
    for (const style of STYLES) {
      expect(style.variants.exploration).toBeDefined();
      expect(style.variants.combat).toBeDefined();
      expect(style.variants.ooc).toBeDefined();
      expect(style.variants.levelup).toBeDefined();
    }
  });

  it("all variants have required fields", () => {
    for (const style of STYLES) {
      for (const variant of Object.values(style.variants)) {
        expect(variant.horizontal).toBeDefined();
        expect(variant.vertical).toBeDefined();
        expect(variant.corner_tl).toBeDefined();
        expect(variant.corner_tr).toBeDefined();
        expect(variant.corner_bl).toBeDefined();
        expect(variant.corner_br).toBeDefined();
        expect(variant.flourish).toContain("%s");
      }
    }
  });

  it("all styles have at least one genre tag", () => {
    for (const style of STYLES) {
      expect(style.genre_tags.length).toBeGreaterThan(0);
    }
  });
});

describe("getStyle", () => {
  it("finds style by name", () => {
    expect(getStyle("gothic")?.name).toBe("gothic");
    expect(getStyle("terminal")?.name).toBe("terminal");
  });

  it("returns undefined for unknown style", () => {
    expect(getStyle("nope")).toBeUndefined();
  });
});

describe("styleForGenre", () => {
  it("maps horror to gothic", () => {
    expect(styleForGenre("horror").name).toBe("gothic");
  });

  it("maps sci-fi to terminal", () => {
    expect(styleForGenre("sci-fi").name).toBe("terminal");
  });

  it("maps high_fantasy to arcane", () => {
    expect(styleForGenre("high_fantasy").name).toBe("arcane");
  });

  it("falls back to clean for unknown genre", () => {
    expect(styleForGenre("abstract interpretive dance").name).toBe("clean");
  });

  it("normalizes spaces to underscores", () => {
    expect(styleForGenre("dark fantasy").name).toBe("gothic");
  });
});

describe("renderHorizontalFrame", () => {
  const gothic = getStyle("gothic")!.variants.exploration;

  it("renders a basic top border", () => {
    const line = renderHorizontalFrame(gothic, 40, "top");
    expect(line.startsWith("╔")).toBe(true);
    expect(line.endsWith("╗")).toBe(true);
    expect(line).toHaveLength(40);
  });

  it("renders a bottom border", () => {
    const line = renderHorizontalFrame(gothic, 40, "bottom");
    expect(line.startsWith("╚")).toBe(true);
    expect(line.endsWith("╝")).toBe(true);
  });

  it("renders with centered text", () => {
    const line = renderHorizontalFrame(gothic, 40, "bottom", "Aldric's Turn");
    expect(line).toContain("Aldric's Turn");
    expect(line).toHaveLength(40);
  });

  it("handles ASCII fallback", () => {
    const line = renderHorizontalFrame(gothic, 40, "top", undefined, true);
    expect(line.startsWith("+")).toBe(true);
    expect(line.endsWith("+")).toBe(true);
    expect(line).toContain("-");
  });

  it("handles very narrow width", () => {
    const line = renderHorizontalFrame(gothic, 3, "top");
    expect(line.length).toBeLessThanOrEqual(3);
  });
});

describe("renderContentLine", () => {
  const gothic = getStyle("gothic")!.variants.exploration;

  it("renders content with borders", () => {
    const line = renderContentLine(gothic, "Hello world", 40);
    expect(line.startsWith("║ ")).toBe(true);
    expect(line.endsWith(" ║")).toBe(true);
    expect(line).toContain("Hello world");
    expect(line).toHaveLength(40);
  });

  it("truncates long content", () => {
    const long = "A".repeat(100);
    const line = renderContentLine(gothic, long, 40);
    expect(line).toHaveLength(40);
    expect(line).toContain("…");
  });

  it("pads short content", () => {
    const line = renderContentLine(gothic, "Hi", 40);
    expect(line).toHaveLength(40);
  });

  it("handles ASCII fallback", () => {
    const line = renderContentLine(gothic, "Hi", 40, true);
    expect(line.startsWith("| ")).toBe(true);
    expect(line.endsWith(" |")).toBe(true);
  });
});

describe("renderTopFrame", () => {
  const gothic = getStyle("gothic")!.variants.exploration;

  it("renders with campaign name and resources", () => {
    const lines = renderTopFrame(gothic, 60, "The Shattered Crown", [
      "HP: 42/42",
      "Mana: 7/12",
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("╔");
    expect(lines[1]).toContain("The Shattered Crown");
  });

  it("includes resources when space permits", () => {
    const lines = renderTopFrame(gothic, 80, "Campaign", [
      "HP: 42/42",
      "Mana: 7/12",
    ]);
    const content = lines[1];
    expect(content).toContain("HP: 42/42");
    expect(content).toContain("Mana: 7/12");
    expect(content).toContain("Campaign");
  });

  it("handles no resources", () => {
    const lines = renderTopFrame(gothic, 60, "Campaign", []);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Campaign");
  });
});

describe("renderVerticalFrame", () => {
  const gothic = getStyle("gothic")!.variants.exploration;

  it("renders a single vertical char at width 1", () => {
    const result = renderVerticalFrame(gothic, "left", 1);
    expect(result).toBe("║");
    expect(result).toHaveLength(1);
  });

  it("returns same char for left and right at width 1", () => {
    const left = renderVerticalFrame(gothic, "left", 1);
    const right = renderVerticalFrame(gothic, "right", 1);
    expect(left).toBe(right);
  });

  it("renders left frame at width 2 with trailing space", () => {
    const result = renderVerticalFrame(gothic, "left", 2);
    expect(result).toBe("║ ");
    expect(result).toHaveLength(2);
  });

  it("renders right frame at width 2 with leading space", () => {
    const result = renderVerticalFrame(gothic, "right", 2);
    expect(result).toBe(" ║");
    expect(result).toHaveLength(2);
  });

  it("uses ASCII fallback", () => {
    const result = renderVerticalFrame(gothic, "left", 1, true);
    expect(result).toBe("|");
  });

  it("uses ASCII fallback at width 2", () => {
    const left = renderVerticalFrame(gothic, "left", 2, true);
    const right = renderVerticalFrame(gothic, "right", 2, true);
    expect(left).toBe("| ");
    expect(right).toBe(" |");
  });

  it("works with combat variant", () => {
    const combat = getStyle("gothic")!.variants.combat;
    expect(renderVerticalFrame(combat, "left", 1)).toBe("┃");
  });
});

describe("stringWidth", () => {
  it("returns length for plain text", () => {
    expect(stringWidth("hello")).toBe(5);
  });

  it("strips ANSI escape codes", () => {
    expect(stringWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });
});

describe("truncateToWidth", () => {
  it("returns string unchanged if within width", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
  });

  it("truncates with ellipsis", () => {
    const result = truncateToWidth("hello world", 8);
    expect(stringWidth(result)).toBeLessThanOrEqual(8);
    expect(result).toContain("…");
  });

  it("handles width of 1", () => {
    expect(truncateToWidth("hello", 1)).toHaveLength(1);
  });
});
