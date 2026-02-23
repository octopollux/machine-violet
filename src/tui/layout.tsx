import React from "react";
import { Box } from "ink";
import type { FrameStyle, StyleVariant, ViewportDimensions, NarrativeLine } from "../types/tui.js";
import type { PlayerEntry } from "./components/index.js";
import type { NarrativeAreaHandle } from "./components/index.js";
import {
  Modeline,
  InputLine,
  PlayerSelector,
  ActivityLine,
  NarrativeArea,
  HorizontalBorder,
  SideFrame,
} from "./components/index.js";
import {
  getViewportTier,
  getVisibleElements,
  useAsciiFallback,
  narrativeRows,
} from "./responsive.js";
import { renderTopFrame } from "./frames/index.js";
import { getActivity } from "./activity.js";
import { Text } from "ink";

export interface LayoutProps {
  /** Terminal dimensions */
  dimensions: ViewportDimensions;
  /** Active frame style */
  style: FrameStyle;
  /** Active style variant */
  variant: StyleVariant;

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

  // Display options
  quoteColor?: string;
  playerColor?: string;
  /** Color for the turn indicator text (player color on their turn, theme color on DM turn). */
  turnIndicatorColor?: string;

  /** Ref to NarrativeArea scroll handle */
  narrativeRef?: React.Ref<NarrativeAreaHandle>;
}

/**
 * Main TUI layout. Composes all elements with responsive breakpoints.
 */
export function Layout(props: LayoutProps) {
  const {
    dimensions,
    style,
    variant,
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
    quoteColor,
    playerColor,
    turnIndicatorColor,
    narrativeRef,
  } = props;

  const tier = getViewportTier(dimensions);
  const elements = getVisibleElements(tier);
  const ascii = useAsciiFallback(dimensions.columns);
  const frameVariant = style.variants[variant];
  const width = dimensions.columns;
  const narRows = narrativeRows(dimensions.rows, elements);

  // Side frame width (1 for now, designed to support 2 later)
  const sideFrameWidth: 1 | 2 = 1;

  // Activity glyph for modeline (when activity line dropped)
  const activity = getActivity(engineState);
  const actGlyph = elements.activityGlyphInModeline ? activity?.glyph : undefined;

  // Turn info for modeline (when lower frame dropped)
  const turnForModeline = elements.turnInfoInModeline ? turnHolder : undefined;

  // Height and inner width of the middle section (narrative + activity) for side frames
  const middleHeight = narRows + (elements.activityLine ? 1 : 0);
  const innerWidth = elements.sideFrames ? width - 2 * sideFrameWidth : width;

  return (
    <Box flexDirection="column" width={width} height={dimensions.rows}>
      {/* Top Frame (resource display) */}
      {elements.topFrame && (
        <TopFrameBlock
          variant={frameVariant}
          width={width}
          campaignName={campaignName}
          resources={resources}
          ascii={ascii}
        />
      )}

      {/* Middle section: optional side frames + narrative + activity */}
      <Box flexDirection="row">
        {elements.sideFrames && (
          <SideFrame
            variant={frameVariant}
            side="left"
            height={middleHeight}
            frameWidth={sideFrameWidth}
            ascii={ascii}
          />
        )}

        <Box flexDirection="column" width={innerWidth}>
          {/* Narrative Area */}
          <NarrativeArea ref={narrativeRef} lines={narrativeLines} maxRows={narRows} quoteColor={quoteColor} playerColor={playerColor} width={innerWidth} />

          {/* Activity Line */}
          {elements.activityLine && <ActivityLine engineState={engineState} />}
        </Box>

        {elements.sideFrames && (
          <SideFrame
            variant={frameVariant}
            side="right"
            height={middleHeight}
            frameWidth={sideFrameWidth}
            ascii={ascii}
          />
        )}
      </Box>

      {/* Lower Frame (turn indicator) */}
      {elements.lowerFrame && (
        <HorizontalBorder
          variant={frameVariant}
          width={width}
          position="bottom"
          centerText={turnHolder ? `${turnHolder}'s Turn` : undefined}
          centerTextColor={turnIndicatorColor}
          ascii={ascii}
        />
      )}

      {/* Modeline */}
      {elements.modeline && (
        <Modeline
          text={modelineText}
          activityGlyph={actGlyph}
          turnInfo={turnForModeline}
          width={width}
        />
      )}

      {/* Input Line */}
      <InputLine
        characterName={activeCharacterName}
        showPlayerName={elements.playerInPrompt}
        playerName={players[activePlayerIndex]?.name}
        width={width}
        isDisabled={inputIsDisabled}
        onChange={onInputChange}
        onSubmit={onInputSubmit}
        resetKey={inputResetKey}
      />

      {/* Player Selector */}
      {elements.playerSelector && (
        <PlayerSelector
          players={players}
          activeIndex={activePlayerIndex}
        />
      )}
    </Box>
  );
}

/** Renders the top frame (border + resource line) */
function TopFrameBlock({
  variant,
  width,
  campaignName,
  resources,
  ascii,
}: {
  variant: LayoutProps["style"]["variants"]["exploration"];
  width: number;
  campaignName: string;
  resources: string[];
  ascii: boolean;
}) {
  const lines = renderTopFrame(variant, width, campaignName, resources, ascii);

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={variant.color}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}
