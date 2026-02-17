import React from "react";
import { Box } from "ink";
import type { FrameStyle, StyleVariant, ViewportDimensions } from "../types/tui.js";
import type { PlayerEntry } from "./components/index.js";
import {
  Modeline,
  InputLine,
  PlayerSelector,
  ActivityLine,
  NarrativeArea,
  HorizontalBorder,
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
  narrativeLines: string[];
  modelineText: string;
  inputValue: string;
  activeCharacterName: string;

  // Player state
  players: PlayerEntry[];
  activePlayerIndex: number;

  // Resource display
  campaignName: string;
  resources: string[];

  // Turn/activity
  turnHolder?: string;
  engineState: string | null;
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
    inputValue,
    activeCharacterName,
    players,
    activePlayerIndex,
    campaignName,
    resources,
    turnHolder,
    engineState,
  } = props;

  const tier = getViewportTier(dimensions);
  const elements = getVisibleElements(tier);
  const ascii = useAsciiFallback(dimensions.columns);
  const frameVariant = style.variants[variant];
  const width = dimensions.columns;
  const narRows = narrativeRows(dimensions.rows, elements);

  // Activity glyph for modeline (when activity line dropped)
  const activity = getActivity(engineState);
  const actGlyph = elements.activityGlyphInModeline ? activity?.glyph : undefined;

  // Turn info for modeline (when lower frame dropped)
  const turnForModeline = elements.turnInfoInModeline ? turnHolder : undefined;

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

      {/* Narrative Area */}
      <NarrativeArea lines={narrativeLines} maxRows={narRows} />

      {/* Activity Line */}
      {elements.activityLine && <ActivityLine engineState={engineState} />}

      {/* Lower Frame (turn indicator) */}
      {elements.lowerFrame && (
        <HorizontalBorder
          variant={frameVariant}
          width={width}
          position="bottom"
          centerText={turnHolder ? `${turnHolder}'s Turn` : undefined}
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
        value={inputValue}
        showPlayerName={elements.playerInPrompt}
        playerName={players[activePlayerIndex]?.name}
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
