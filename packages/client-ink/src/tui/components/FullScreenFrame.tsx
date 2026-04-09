import React from "react";
import { Box } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame } from "./ThemedFrame.js";
import { useStarfield, StarfieldRows } from "./Starfield.js";
import type { StarfieldConfig } from "./Starfield.js";

export interface FullScreenFrameProps {
  theme: ResolvedTheme;
  columns: number;
  rows: number;
  /** Centered title rendered in the top border. */
  title?: string;
  /** Number of content rows the children occupy (used for vertical centering). */
  contentRows: number;
  /** Enable an animated starfield in the padding areas around content. */
  starfield?: boolean | StarfieldConfig;
  children: React.ReactNode;
}

/**
 * Full-screen themed frame for out-of-game pages (main menu, settings, etc.).
 * Renders top/bottom ThemedHorizontalBorder, left/right ThemedSideFrame,
 * and vertically centers children within the content area.
 */
export function FullScreenFrame({
  theme,
  columns,
  rows,
  title,
  contentRows,
  starfield,
  children,
}: FullScreenFrameProps) {
  const sideWidth = theme.asset.components.edge_left.width;
  const borderHeight = theme.asset.height;

  const contentWidth = columns - sideWidth * 2;
  const contentHeight = rows - borderHeight * 2;

  const topPad = Math.max(0, Math.floor((contentHeight - contentRows) / 2));
  const bottomPad = Math.max(0, contentHeight - contentRows - topPad);

  const sfEnabled = !!starfield;
  const sfConfig: StarfieldConfig = {
    ...(typeof starfield === "object" ? starfield : undefined),
    isActive: sfEnabled,
  };

  // Hook is called unconditionally (Rules of Hooks); isActive gates animation.
  const grid = useStarfield(contentWidth, contentHeight, sfConfig);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <ThemedHorizontalBorder
        theme={theme}
        width={columns}
        position="top"
        centerText={title}
      />

      <Box flexDirection="row" height={contentHeight}>
        <ThemedSideFrame theme={theme} side="left" height={contentHeight} />
        <Box flexDirection="column" width={contentWidth} alignItems="center">
          {topPad > 0 && (
            sfEnabled
              ? <StarfieldRows grid={grid} startRow={0} rowCount={topPad} />
              : <Box height={topPad} />
          )}

          <Box flexDirection="column" alignItems="flex-start">
            {children}
          </Box>

          {bottomPad > 0 && (
            sfEnabled
              ? <StarfieldRows grid={grid} startRow={topPad + contentRows} rowCount={bottomPad} />
              : <Box height={bottomPad} />
          )}
        </Box>
        <ThemedSideFrame theme={theme} side="right" height={contentHeight} />
      </Box>

      <ThemedHorizontalBorder
        theme={theme}
        width={columns}
        position="bottom"
      />
    </Box>
  );
}
