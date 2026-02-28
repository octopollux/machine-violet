import { describe, it, expect } from "vitest";
import {
  tileToWidth,
  composeTopFrame,
  composeBottomFrame,
  composeSimpleBorder,
  composeSideColumn,
  composeTurnSeparator,
  playerPaneSideChar,
  playerPaneSideColumn,
} from "./composer.js";
import { parseThemeAsset, parsePlayerPaneFrame } from "./parser.js";

// Height-1 theme for simple tests
const H1_THEME = `@name: simple
@height: 1

[corner_tl]
+

[corner_tr]
+

[corner_bl]
+

[corner_br]
+

[edge_top]
-

[edge_bottom]
-

[edge_left]
|

[edge_right]
|

[separator_left_top]
[

[separator_right_top]
]

[separator_left_bottom]
[

[separator_right_bottom]
]

[turn_separator]
-- * --
`;

// Height-2 theme
const H2_THEME = `@name: fancy
@height: 2

[corner_tl]
╔═
║·

[corner_tr]
═╗
·║

[corner_bl]
║·
╚═

[corner_br]
·║
═╝

[edge_top]
═─
··

[edge_bottom]
··
═─

[edge_left]
║
║

[edge_right]
║
║

[separator_left_top]
╠─
║·

[separator_right_top]
─╣
·║

[separator_left_bottom]
║·
╠─

[separator_right_bottom]
·║
─╝

[turn_separator]
── ◆ ──
`;

describe("tileToWidth", () => {
  it("tiles a single char to fill width", () => {
    expect(tileToWidth("─", 5)).toBe("─────");
  });

  it("tiles a multi-char pattern", () => {
    expect(tileToWidth("═─", 6)).toBe("═─═─═─");
  });

  it("truncates when pattern doesn't divide evenly", () => {
    expect(tileToWidth("═─", 5)).toBe("═─═─═");
  });

  it("returns empty for 0 width", () => {
    expect(tileToWidth("═", 0)).toBe("");
  });

  it("returns spaces for empty pattern", () => {
    expect(tileToWidth("", 3)).toBe("   ");
  });
});

describe("composeTopFrame", () => {
  it("composes a height-1 frame without title", () => {
    const asset = parseThemeAsset(H1_THEME);
    const frame = composeTopFrame(asset, 20);
    expect(frame.height).toBe(1);
    expect(frame.rows[0].length).toBe(20);
    // Should start with corner and end with corner
    expect(frame.rows[0][0]).toBe("+");
    expect(frame.rows[0][19]).toBe("+");
  });

  it("composes a height-1 frame with title", () => {
    const asset = parseThemeAsset(H1_THEME);
    const frame = composeTopFrame(asset, 30, "GAME");
    expect(frame.height).toBe(1);
    expect(frame.rows[0]).toContain(" GAME ");
    expect(frame.rows[0].length).toBe(30);
  });

  it("composes a height-2 frame", () => {
    const asset = parseThemeAsset(H2_THEME);
    const frame = composeTopFrame(asset, 30, "TITLE");
    expect(frame.height).toBe(2);
    // Row 0 should have title
    expect(frame.rows[0]).toContain(" TITLE ");
    // Row 1 should have spaces where title was
    expect(frame.rows[1]).not.toContain("TITLE");
    // Both rows same length
    expect(frame.rows[0].length).toBe(30);
    expect(frame.rows[1].length).toBe(30);
  });

  it("all rows have exact target width", () => {
    const asset = parseThemeAsset(H2_THEME);
    const frame = composeTopFrame(asset, 50, "My Campaign");
    for (const row of frame.rows) {
      expect(row.length).toBe(50);
    }
  });

  it("works without title (no separators)", () => {
    const asset = parseThemeAsset(H1_THEME);
    const frame = composeTopFrame(asset, 20);
    // No separators when no title
    expect(frame.rows[0]).not.toContain("[");
    expect(frame.rows[0]).not.toContain("]");
  });
});

describe("composeBottomFrame", () => {
  it("composes a height-1 frame without turn indicator", () => {
    const asset = parseThemeAsset(H1_THEME);
    const frame = composeBottomFrame(asset, 20);
    expect(frame.height).toBe(1);
    expect(frame.rows[0].length).toBe(20);
    expect(frame.rows[0][0]).toBe("+");
  });

  it("turn indicator appears on last row", () => {
    const asset = parseThemeAsset(H1_THEME);
    const frame = composeBottomFrame(asset, 30, "Turn 1");
    expect(frame.rows[frame.height - 1]).toContain(" Turn 1 ");
  });

  it("height-2 frame has turn on last row", () => {
    const asset = parseThemeAsset(H2_THEME);
    const frame = composeBottomFrame(asset, 40, "Round 3");
    expect(frame.rows[1]).toContain(" Round 3 ");
    expect(frame.rows[0]).not.toContain("Round 3");
  });
});

// Player pane frame for composeSimpleBorder tests
const SIMPLE_FRAME = `@name: simple-frame

[corner_tl]
+

[corner_tr]
+

[corner_bl]
+

[corner_br]
+

[edge_top]
-

[edge_bottom]
-

[edge_left]
|

[edge_right]
|
`;

describe("composeSimpleBorder", () => {
  it("creates a 1-row top border with corners", () => {
    const frame = parsePlayerPaneFrame(SIMPLE_FRAME);
    const composed = composeSimpleBorder(frame, 15, "top");
    expect(composed.height).toBe(1);
    expect(composed.rows[0].length).toBe(15);
    // Corners from corner_tl/corner_tr + tiled edge
    expect(composed.rows[0]).toBe("+-------------+");
  });

  it("creates a 1-row bottom border with corners", () => {
    const frame = parsePlayerPaneFrame(SIMPLE_FRAME);
    const composed = composeSimpleBorder(frame, 10, "bottom");
    expect(composed.height).toBe(1);
    expect(composed.rows[0].length).toBe(10);
    expect(composed.rows[0]).toBe("+--------+");
  });
});

// Corners-only player frame (edges default to space)
const CORNERS_ONLY_FRAME = `@name: corners-only

[corner_tl]
+

[corner_tr]
+

[corner_bl]
+

[corner_br]
+
`;

describe("composeSimpleBorder (corners-only frame)", () => {
  it("fills edge area with spaces when edges are absent", () => {
    const frame = parsePlayerPaneFrame(CORNERS_ONLY_FRAME);
    const composed = composeSimpleBorder(frame, 10, "top");
    // Corners + spaces between
    expect(composed.rows[0]).toBe("+        +");
    expect(composed.rows[0].length).toBe(10);
  });

  it("bottom border also fills with spaces", () => {
    const frame = parsePlayerPaneFrame(CORNERS_ONLY_FRAME);
    const composed = composeSimpleBorder(frame, 10, "bottom");
    expect(composed.rows[0]).toBe("+        +");
  });
});

describe("playerPaneSideChar (corners-only frame)", () => {
  it("returns space for left side when edge_left is absent", () => {
    const frame = parsePlayerPaneFrame(CORNERS_ONLY_FRAME);
    expect(playerPaneSideChar(frame, "left")).toBe(" ");
  });

  it("returns space for right side when edge_right is absent", () => {
    const frame = parsePlayerPaneFrame(CORNERS_ONLY_FRAME);
    expect(playerPaneSideChar(frame, "right")).toBe(" ");
  });
});

describe("composeSideColumn", () => {
  it("tiles edge vertically for the given height", () => {
    const asset = parseThemeAsset(H1_THEME);
    const col = composeSideColumn(asset, "left", 5);
    expect(col).toHaveLength(5);
    expect(col.every((r) => r === "|")).toBe(true);
  });

  it("tiles height-2 edge pattern correctly", () => {
    const asset = parseThemeAsset(H2_THEME);
    const col = composeSideColumn(asset, "left", 4);
    expect(col).toHaveLength(4);
    // Pattern repeats: ║, ║, ║, ║
    expect(col[0]).toBe("║");
    expect(col[1]).toBe("║");
  });

  it("handles 0 height", () => {
    const asset = parseThemeAsset(H1_THEME);
    expect(composeSideColumn(asset, "right", 0)).toHaveLength(0);
  });
});

describe("composeTurnSeparator", () => {
  it("centers separator in width", () => {
    const asset = parseThemeAsset(H1_THEME);
    const sep = composeTurnSeparator(asset, 20);
    expect(sep.length).toBe(20);
    expect(sep.trim()).toBe("-- * --");
  });

  it("truncates if width is too narrow", () => {
    const asset = parseThemeAsset(H1_THEME);
    const sep = composeTurnSeparator(asset, 5);
    expect(sep.length).toBe(5);
  });

  it("handles exact width match", () => {
    const asset = parseThemeAsset(H1_THEME);
    const sep = composeTurnSeparator(asset, 7);
    expect(sep).toBe("-- * --");
  });
});

// Multi-row corner player-pane frame (3-row corners, like default.player-frame)
const MULTI_ROW_FRAME = `@name: multi-row
[corner_tl]
┌
│
(

[corner_tr]
┐
|
)

[corner_bl]
(
|
└

[corner_br]
)
|
┘

[edge_top]
─

[edge_bottom]
─

[edge_left]
│

[edge_right]
│
`;

describe("composeSimpleBorder (multi-row corners)", () => {
  it("top border uses corner row 0", () => {
    const frame = parsePlayerPaneFrame(MULTI_ROW_FRAME);
    const composed = composeSimpleBorder(frame, 12, "top");
    expect(composed.rows[0]).toBe("┌──────────┐");
    expect(composed.rows[0].length).toBe(12);
  });

  it("bottom border uses corner last row", () => {
    const frame = parsePlayerPaneFrame(MULTI_ROW_FRAME);
    const composed = composeSimpleBorder(frame, 12, "bottom");
    // corner_bl last row = "└", corner_br last row = "┘"
    expect(composed.rows[0]).toBe("└──────────┘");
    expect(composed.rows[0].length).toBe(12);
  });
});

describe("playerPaneSideColumn (multi-row corners)", () => {
  it("composites top corner, edge, bottom corner for left side", () => {
    const frame = parsePlayerPaneFrame(MULTI_ROW_FRAME);
    // 3-row corners → topRows=2, bottomRows=2, contentHeight=7 → 3 middle rows
    const col = playerPaneSideColumn(frame, "left", 7);
    expect(col).toHaveLength(7);
    // Top corner rows 1,2 (first char)
    expect(col[0]).toBe("│"); // corner_tl row 1
    expect(col[1]).toBe("("); // corner_tl row 2
    // Middle rows: edge_left
    expect(col[2]).toBe("│");
    expect(col[3]).toBe("│");
    expect(col[4]).toBe("│");
    // Bottom corner rows 0,1 (first char)
    expect(col[5]).toBe("("); // corner_bl row 0
    expect(col[6]).toBe("|"); // corner_bl row 1
  });

  it("composites top corner, edge, bottom corner for right side", () => {
    const frame = parsePlayerPaneFrame(MULTI_ROW_FRAME);
    const col = playerPaneSideColumn(frame, "right", 7);
    expect(col).toHaveLength(7);
    // Top corner rows 1,2 (last char)
    expect(col[0]).toBe("|"); // corner_tr row 1
    expect(col[1]).toBe(")"); // corner_tr row 2
    // Middle rows: edge_right
    expect(col[2]).toBe("│");
    expect(col[3]).toBe("│");
    expect(col[4]).toBe("│");
    // Bottom corner rows 0,1 (last char)
    expect(col[5]).toBe(")"); // corner_br row 0
    expect(col[6]).toBe("|"); // corner_br row 1
  });

  it("handles single-row corners (no underlap)", () => {
    const frame = parsePlayerPaneFrame(SIMPLE_FRAME);
    // 1-row corners → topRows=0, bottomRows=0, all middle
    const col = playerPaneSideColumn(frame, "left", 5);
    expect(col).toHaveLength(5);
    expect(col.every((ch) => ch === "|")).toBe(true);
  });

  it("handles 0 content height", () => {
    const frame = parsePlayerPaneFrame(MULTI_ROW_FRAME);
    const col = playerPaneSideColumn(frame, "left", 0);
    expect(col).toHaveLength(0);
  });
});

describe("playerPaneSideColumn (corners-only frame)", () => {
  it("returns spaces when edges are absent", () => {
    const frame = parsePlayerPaneFrame(CORNERS_ONLY_FRAME);
    const col = playerPaneSideColumn(frame, "left", 5);
    expect(col).toHaveLength(5);
    // 1-row corners → all edge chars → space (from default edge)
    expect(col.every((ch) => ch === " ")).toBe(true);
  });
});
