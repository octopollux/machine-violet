import React, { useState } from "react";
import { useInput, Text, Box, useWindowSize } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import type { UpdateInfo } from "../config/updater.js";
import { ThemedHorizontalBorder, ThemedSideFrame, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { themeColor } from "../tui/themes/color-resolve.js";

export interface UpdatePhaseProps {
  theme: ResolvedTheme;
  updateInfo: UpdateInfo;
  onApply: () => void;
  onBack: () => void;
}

const OPTIONS = ["Install update", "Back"] as const;

export function UpdatePhase({
  theme,
  updateInfo,
  onApply,
  onBack,
}: UpdatePhaseProps) {
  const { columns: cols, rows: termRows } = useWindowSize();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(OPTIONS.length - 1, i + 1));
      return;
    }
    if (key.return) {
      if (selectedIndex === 0) onApply();
      else onBack();
    }
  });

  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  const borderColor = themeColor(theme, "border");
  const dimColor = themeColor(theme, "separator") ?? "#666666";
  const sideWidth = theme.asset.components.edge_left.width;
  const topHeight = theme.asset.height;

  const contentWidth = cols - sideWidth * 2;
  const contentHeight = termRows - topHeight * 2;

  const lines: React.ReactNode[] = [];

  lines.push(
    <Text key="heading" bold>Update Available</Text>,
  );
  lines.push(
    <Text key="spacer1">{" "}</Text>,
  );
  lines.push(
    <Text key="version" color="yellow" bold>
      {`v${updateInfo.currentVersion}  →  v${updateInfo.latestVersion}`}
    </Text>,
  );

  if (updateInfo.releaseNotes) {
    lines.push(
      <Text key="spacer2">{" "}</Text>,
    );
    // Render release notes as simple text lines, capped to fit
    const maxNoteLines = Math.max(1, contentHeight - 10);
    const noteLines = updateInfo.releaseNotes.split(/\r?\n/).slice(0, maxNoteLines);
    for (let i = 0; i < noteLines.length; i++) {
      lines.push(
        <Text key={`note-${i}`} color={dimColor} wrap="truncate">{noteLines[i]}</Text>,
      );
    }
  }

  lines.push(
    <Text key="spacer3">{" "}</Text>,
  );

  for (let i = 0; i < OPTIONS.length; i++) {
    const isSelected = i === selectedIndex;
    const marker = isSelected ? "◆" : "○";
    const markerColor = isSelected ? borderColor : dimColor;
    lines.push(
      <Text key={OPTIONS[i]}>
        <Text color={markerColor}>{marker}</Text>
        <Text>{` ${OPTIONS[i]}`}</Text>
      </Text>,
    );
  }

  const totalHeight = lines.length;
  const topPad = Math.max(0, Math.floor((contentHeight - totalHeight) / 2));
  const bottomPad = Math.max(0, contentHeight - totalHeight - topPad);

  return (
    <Box flexDirection="column" width={cols} height={termRows}>
      <ThemedHorizontalBorder theme={theme} width={cols} position="top" centerText="Update" />

      <Box flexDirection="row" height={contentHeight}>
        <ThemedSideFrame theme={theme} side="left" height={contentHeight} />
        <Box flexDirection="column" width={contentWidth} alignItems="center">
          {topPad > 0 && <Box height={topPad} />}
          <Box flexDirection="column" alignItems="flex-start">
            {lines}
          </Box>
          {bottomPad > 0 && <Box height={bottomPad} />}
        </Box>
        <ThemedSideFrame theme={theme} side="right" height={contentHeight} />
      </Box>

      <ThemedHorizontalBorder theme={theme} width={cols} position="bottom" />
    </Box>
  );
}
