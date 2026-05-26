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
  /**
   * Optional one-row content pinned to the bottom-left of the frame (just above
   * the bottom border). Consumes one row from the bottom padding; does not
   * affect the vertical centering of the main children. Content is clipped to
   * a single row to keep the layout stable.
   *
   * Note: not currently composited with starfield — when both are enabled, the
   * slot row appears as a non-animated stripe within the otherwise-animated
   * padding. Add starfield-aware rendering here when a caller needs both.
   */
  bottomLeft?: React.ReactNode;
  /**
   * Optional content pinned to the top of the frame (just below the top
   * border). Lives in the top-padding region: consumes `topBannerRows` rows
   * from the top pad so the centered children's vertical position is
   * preserved whether or not the banner is present. Caller is responsible
   * for sizing `topBannerRows` to match the rendered content (pre-wrapped
   * line count); under-sizing clips, over-sizing leaves blank space.
   *
   * Use case: out-of-band status surfaces like the session-fatal banner on
   * the main menu (#529) that need to be prominent but must not shift the
   * primary menu around when they toggle in and out.
   */
  topBanner?: React.ReactNode;
  topBannerRows?: number;
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
  bottomLeft,
  topBanner,
  topBannerRows = 0,
  children,
}: FullScreenFrameProps) {
  const sideWidth = theme.asset.components.edge_left.width;
  const borderHeight = theme.asset.height;

  const contentWidth = columns - sideWidth * 2;
  const contentHeight = rows - borderHeight * 2;

  const topPad = Math.max(0, Math.floor((contentHeight - contentRows) / 2));
  const rawBottomPad = Math.max(0, contentHeight - contentRows - topPad);
  // Pinned bottom-left row eats one row from the bottom padding so it doesn't
  // disturb the vertical centering of the main children.
  const hasBottomLeft = bottomLeft != null && rawBottomPad >= 1;
  const bottomPad = hasBottomLeft ? rawBottomPad - 1 : rawBottomPad;
  // Pinned top banner eats `topBannerRows` rows from the top padding so the
  // centered children's Y position is preserved. If the banner is taller
  // than the available top pad (very small terminal), it overflows past
  // the pad and shifts the menu down — acceptable degradation versus
  // hiding the message.
  const hasTopBanner = topBanner != null && topBannerRows > 0;
  const visibleTopPad = hasTopBanner ? Math.max(0, topPad - topBannerRows) : topPad;

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
          {hasTopBanner && (
            <Box
              width={contentWidth}
              flexDirection="column"
              alignItems="flex-start"
              flexShrink={0}
            >
              {topBanner}
            </Box>
          )}

          {visibleTopPad > 0 && (
            sfEnabled
              ? <StarfieldRows grid={grid} startRow={hasTopBanner ? topBannerRows : 0} rowCount={visibleTopPad} />
              : <Box height={visibleTopPad} />
          )}

          <Box flexDirection="column" alignItems="flex-start">
            {children}
          </Box>

          {bottomPad > 0 && (
            sfEnabled
              ? <StarfieldRows grid={grid} startRow={topPad + contentRows} rowCount={bottomPad} />
              : <Box height={bottomPad} />
          )}

          {hasBottomLeft && (
            <Box
              width={contentWidth}
              height={1}
              overflow="hidden"
              justifyContent="flex-start"
            >
              {bottomLeft}
            </Box>
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
