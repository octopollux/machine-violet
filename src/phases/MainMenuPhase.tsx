import React, { useState } from "react";
import { useInput, Text, Box } from "ink";
import type { CampaignEntry } from "../config/main-menu.js";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { themeColor } from "../tui/themes/color-resolve.js";

export interface MainMenuPhaseProps {
  theme: ResolvedTheme;
  campaigns: CampaignEntry[];
  errorMsg: string | null;
  onNewCampaign: () => void;
  onResumeCampaign: (entry: CampaignEntry) => void;
  onAddContent: () => void;
  onQuit: () => void;
}

export function MainMenuPhase({
  theme,
  campaigns,
  errorMsg,
  onNewCampaign,
  onResumeCampaign,
  onAddContent,
  onQuit,
}: MainMenuPhaseProps) {
  const { columns: cols, rows: termRows } = useTerminalSize();
  const [mainMenuIndex, setMainMenuIndex] = useState(0);
  const [expandedCampaigns, setExpandedCampaigns] = useState(false);
  const [campaignSelectIndex, setCampaignSelectIndex] = useState(0);

  const mainMenuItems = campaigns.length > 0
    ? ["New Campaign", "Continue Campaign", "Add Content", "Quit"]
    : ["New Campaign", "Add Content", "Quit"];

  useInput((input, key) => {
    // Campaign sub-list navigation
    if (expandedCampaigns && campaigns.length > 0) {
      if (key.upArrow) {
        if (campaignSelectIndex === 0) {
          // Move back to "Continue Campaign" item
          setExpandedCampaigns(false);
        } else {
          setCampaignSelectIndex((i) => i - 1);
        }
        return;
      }
      if (key.downArrow) {
        setCampaignSelectIndex((i) => Math.min(campaigns.length - 1, i + 1));
        return;
      }
      if (key.return) {
        setExpandedCampaigns(false);
        onResumeCampaign(campaigns[campaignSelectIndex]);
        return;
      }
      if (key.escape) {
        setExpandedCampaigns(false);
        return;
      }
      return;
    }

    if (key.upArrow) {
      setMainMenuIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setMainMenuIndex((i) => Math.min(mainMenuItems.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const selected = mainMenuItems[mainMenuIndex];
      if (selected === "New Campaign") {
        onNewCampaign();
      } else if (selected === "Continue Campaign") {
        setExpandedCampaigns(true);
        setCampaignSelectIndex(0);
      } else if (selected === "Add Content") {
        onAddContent();
      } else if (selected === "Quit") {
        onQuit();
      }
      return;
    }
    if (input === "q" || input === "Q") {
      onQuit();
    }
  });

  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  const borderColor = themeColor(theme, "border");
  const dimColor = themeColor(theme, "separator") ?? "#666666";
  const sideWidth = theme.asset.components.edge_left.width;
  const topHeight = theme.asset.height;

  // Content area dimensions
  const contentWidth = cols - sideWidth * 2;
  const contentHeight = termRows - topHeight * 2; // top + bottom borders

  // Build menu lines
  const menuLines: React.ReactNode[] = [];
  for (let i = 0; i < mainMenuItems.length; i++) {
    const item = mainMenuItems[i];
    const isSelected = !expandedCampaigns && i === mainMenuIndex;
    const marker = isSelected ? "◆" : "○";
    const markerColor = isSelected ? borderColor : dimColor;

    let description = "";
    if (item === "New Campaign") description = "Start a new adventure";
    else if (item === "Continue Campaign" && campaigns.length > 0) description = `${campaigns.length} saved`;
    else if (item === "Add Content") description = "Import PDFs for game systems";

    menuLines.push(
      <Text key={item}>
        <Text color={markerColor}>{marker}</Text>
        <Text>{` ${item}`}</Text>
        {description ? <Text color={dimColor}>{` — ${description}`}</Text> : null}
      </Text>,
    );

    // Inline campaign sub-list when expanded
    if (item === "Continue Campaign" && expandedCampaigns) {
      for (let j = 0; j < campaigns.length; j++) {
        const cSelected = j === campaignSelectIndex;
        const cMarker = cSelected ? "◆" : "○";
        const cColor = cSelected ? borderColor : dimColor;
        menuLines.push(
          <Text key={`c-${campaigns[j].path}`}>
            <Text>{`    `}</Text>
            <Text color={cColor}>{cMarker}</Text>
            <Text>{` ${campaigns[j].name}`}</Text>
          </Text>,
        );
      }
    }
  }

  // Center vertically
  const menuHeight = menuLines.length;
  const topPad = Math.max(0, Math.floor((contentHeight - menuHeight) / 2));
  const bottomPad = Math.max(0, contentHeight - menuHeight - topPad);

  return (
    <Box flexDirection="column" width={cols} height={termRows}>
      {/* Top border */}
      <ThemedHorizontalBorder
        theme={theme}
        width={cols}
        position="top"
        centerText="Machine Violet"
      />

      {/* Content area with side frames */}
      <Box flexDirection="row" height={contentHeight}>
        <ThemedSideFrame theme={theme} side="left" height={contentHeight} />
        <Box flexDirection="column" width={contentWidth} alignItems="center">
          {/* Vertical centering — top padding */}
          {topPad > 0 && <Box height={topPad} />}

          {/* Menu items */}
          <Box flexDirection="column" alignItems="flex-start">
            {menuLines}
          </Box>

          {/* Error message */}
          {errorMsg && (
            <Box marginTop={1}>
              <Text color="red">{errorMsg}</Text>
            </Box>
          )}

          {/* Vertical centering — bottom padding */}
          {bottomPad > 0 && <Box height={bottomPad} />}
        </Box>
        <ThemedSideFrame theme={theme} side="right" height={contentHeight} />
      </Box>

      {/* Bottom border */}
      <ThemedHorizontalBorder
        theme={theme}
        width={cols}
        position="bottom"
      />
    </Box>
  );
}
