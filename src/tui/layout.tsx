import React, { useMemo } from "react";
import { Box } from "ink";
import type { ViewportDimensions, NarrativeLine } from "../types/tui.js";
import type { ToolGlyph } from "./activity.js";
import type { ResolvedTheme } from "./themes/types.js";
import type { PlayerEntry } from "./components/index.js";
import type { NarrativeAreaHandle } from "./components/index.js";
import {
  Modeline,
  buildModelineDisplay,
  splitModeline,
  InputLine,
  PlayerSelector,
  ActivityLine,
  NarrativeArea,
} from "./components/index.js";
import {
  ThemedHorizontalBorder,
  ThemedSideFrame,
  SimpleBorder,
  PlayerPaneSide,
} from "./components/ThemedFrame.js";
import { themeColor } from "./themes/color-resolve.js";
import {
  getViewportTier,
  getVisibleElements,
  narrativeRows,
  PLAYER_PANE_HEIGHT,
} from "./responsive.js";
import { getActivity } from "./activity.js";

export interface LayoutProps {
  /** Terminal dimensions */
  dimensions: ViewportDimensions;
  /** Resolved theme for rendering */
  theme: ResolvedTheme;

  // Content
  narrativeLines: NarrativeLine[];
  modelineText: string;
  activeCharacterName: string;

  // Text input
  inputIsDisabled?: boolean;
  inputResetKey?: number;
  onInputChange?: (value: string) => void;
  onInputSubmit?: (value: string) => void;

  // Player state
  players: PlayerEntry[];
  activePlayerIndex: number;

  // Resource display
  campaignName: string;
  resources: string[];

  // Turn/activity
  turnHolder?: string;
  engineState: string | null;
  toolGlyphs?: ToolGlyph[];

  // Display options
  quoteColor?: string;
  playerColor?: string;
  /** Color for the turn indicator text (player color on their turn, theme color on DM turn). */
  turnIndicatorColor?: string;

  /** Ref to NarrativeArea scroll handle */
  narrativeRef?: React.Ref<NarrativeAreaHandle>;

  /** When true, skip rendering the InputLine (e.g. choice modal provides its own input) */
  hideInputLine?: boolean;

  /** When set, replaces the Player Pane interior (Modeline + InputLine) with this element */
  playerPaneOverlay?: React.ReactNode;

  /** Extra rows to add to the Player Pane (e.g. 3 for a description region in rich choices) */
  playerPaneExtraHeight?: number;
}

/**
 * Main TUI layout — two-pane structure (Conversation Pane + Player Pane).
 * Composes all elements with responsive breakpoints.
 */
export const Layout = React.memo(function Layout(props: LayoutProps) {
  const {
    dimensions,
    theme,
    narrativeLines,
    modelineText,
    activeCharacterName,
    inputIsDisabled,
    inputResetKey,
    onInputChange,
    onInputSubmit,
    players,
    activePlayerIndex,
    campaignName,
    resources,
    turnHolder,
    engineState,
    toolGlyphs,
    quoteColor,
    playerColor,
    turnIndicatorColor,
    narrativeRef,
    hideInputLine,
    playerPaneOverlay,
    playerPaneExtraHeight = 0,
  } = props;

  const tier = getViewportTier(dimensions);
  const elements = getVisibleElements(tier);
  const width = dimensions.columns;

  // Side frame width from theme asset
  const sideFrameWidth = elements.sideFrames ? theme.asset.components.edge_left.width : 0;

  // Activity glyph for modeline (when activity line dropped)
  const activity = getActivity(engineState);
  const actGlyph = elements.activityGlyphInModeline ? activity?.glyph : undefined;

  // Pre-split modeline so we know its height before sizing the narrative area
  const modelineDisplay = buildModelineDisplay(modelineText, actGlyph);
  const modelineLines = splitModeline(modelineDisplay, width);

  // Build resource string for top frame title
  const titleText = resources.length > 0
    ? `${campaignName} | ${resources.join(" | ")}`
    : campaignName;

  // Calculate narrative rows (accounting for themed border heights)
  const narRows = narrativeRows(
    dimensions.rows,
    elements,
    hideInputLine,
    theme.asset.height,
    players.length,
    playerPaneExtraHeight,
  );

  // Fixed content height inside the Player Pane (between top/bottom borders)
  const playerPaneContentHeight = PLAYER_PANE_HEIGHT + elements.playerPaneExtraRows + playerPaneExtraHeight - 2;

  // Height of the middle section (narrative + activity) for side frames
  const middleHeight = narRows + (elements.activityLine ? 1 : 0);
  const sidePadding = elements.sideFrames ? 1 : 0;
  const innerWidth = elements.sideFrames ? width - 2 * sideFrameWidth - 2 * sidePadding : width;

  // Memoize expensive sub-trees that don't change during streaming

  const topFrame = useMemo(
    () => elements.topFrame ? (
      <ThemedHorizontalBorder theme={theme} width={width} position="top" centerText={titleText} />
    ) : null,
    [elements.topFrame, theme, width, titleText],
  );

  const bottomFrame = useMemo(
    () => elements.lowerFrame ? (
      <ThemedHorizontalBorder
        theme={theme} width={width} position="bottom"
        centerText={turnHolder ? `${turnHolder}'s Turn` : undefined}
        centerTextColor={turnIndicatorColor}
      />
    ) : null,
    [elements.lowerFrame, theme, width, turnHolder, turnIndicatorColor],
  );

  const leftSide = useMemo(
    () => elements.sideFrames ? <ThemedSideFrame theme={theme} side="left" height={middleHeight} /> : null,
    [elements.sideFrames, theme, middleHeight],
  );

  const rightSide = useMemo(
    () => elements.sideFrames ? <ThemedSideFrame theme={theme} side="right" height={middleHeight} /> : null,
    [elements.sideFrames, theme, middleHeight],
  );

  const separatorColor = useMemo(() => themeColor(theme, "separator"), [theme]);

  const playerPaneTopBorder = useMemo(
    () => elements.modeline ? <SimpleBorder theme={theme} width={width} position="top" color={playerColor} /> : null,
    [elements.modeline, theme, width, playerColor],
  );

  const playerPaneBottomBorder = useMemo(
    () => elements.modeline ? <SimpleBorder theme={theme} width={width} position="bottom" color={playerColor} /> : null,
    [elements.modeline, theme, width, playerColor],
  );

  return (
    <Box flexDirection="column" width={width} height={dimensions.rows}>
      {/* === CONVERSATION PANE === */}

      {/* Top Frame (themed multi-line border + campaign title) */}
      {topFrame}

      {/* Middle section: optional side frames + narrative + activity */}
      <Box flexDirection="row">
        {leftSide}

        <Box flexDirection="column" width={innerWidth + 2 * sidePadding} paddingLeft={sidePadding} paddingRight={sidePadding}>
          {/* Narrative Area */}
          <NarrativeArea
            ref={narrativeRef}
            lines={narrativeLines}
            maxRows={narRows}
            quoteColor={quoteColor}
            playerColor={playerColor}
            width={innerWidth}
            themeAsset={theme.asset}
            separatorColor={separatorColor}
          />

          {/* Activity Line */}
          {elements.activityLine && <ActivityLine engineState={engineState} toolGlyphs={toolGlyphs} />}
        </Box>

        {rightSide}
      </Box>

      {/* Bottom Frame (themed multi-line border + turn indicator) */}
      {bottomFrame}

      {/* === PLAYER PANE === */}

      {/* Player Pane top border (simple 1-row with corners) */}
      {playerPaneTopBorder}

      {/* Player Pane content: side edges + modeline + input (fixed height) */}
      {elements.modeline && (
        <Box flexDirection="row" height={playerPaneContentHeight}>
          <PlayerPaneSide theme={theme} side="left" color={playerColor} height={playerPaneContentHeight} />
          <Box flexDirection="column" width={width - 2} paddingLeft={1} paddingRight={1}>
            {playerPaneOverlay ? (
              elements.playerPaneExtraRows > 0 ? (
                <>
                  <Modeline lines={modelineLines} width={width - 4} />
                  <Box flexGrow={1} />
                  {playerPaneOverlay}
                </>
              ) : playerPaneOverlay
            ) : (
              <>
                <Modeline lines={modelineLines} width={width - 4} />
                <Box flexGrow={1} />
                {!hideInputLine && (
                  <InputLine
                    characterName={activeCharacterName}
                    showPlayerName={false}
                    playerName={players[activePlayerIndex]?.name}
                    width={width - 4}
                    isDisabled={inputIsDisabled}
                    onChange={onInputChange}
                    onSubmit={onInputSubmit}
                    resetKey={inputResetKey}
                  />
                )}
                <Box height={1} />
              </>
            )}
          </Box>
          <PlayerPaneSide theme={theme} side="right" color={playerColor} height={playerPaneContentHeight} />
        </Box>
      )}

      {/* Player Pane bottom border */}
      {playerPaneBottomBorder}

      {/* Player Selector */}
      {elements.playerSelector && (
        <PlayerSelector players={players} activeIndex={activePlayerIndex} />
      )}
    </Box>
  );
});
