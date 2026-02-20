import React, { useState } from "react";
import { useInput, Text, Box } from "ink";
import type { CampaignEntry } from "../config/main-menu.js";

export interface MainMenuPhaseProps {
  campaigns: CampaignEntry[];
  errorMsg: string | null;
  onNewCampaign: () => void;
  onJumpIn: () => void;
  onResumeCampaign: (entry: CampaignEntry) => void;
}

export function MainMenuPhase({
  campaigns,
  errorMsg,
  onNewCampaign,
  onJumpIn,
  onResumeCampaign,
}: MainMenuPhaseProps) {
  const [mainMenuIndex, setMainMenuIndex] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [campaignSelectIndex, setCampaignSelectIndex] = useState(0);

  const mainMenuItems = campaigns.length > 0
    ? ["New Campaign", "Continue Campaign", "Just Jump In", "Quit"]
    : ["New Campaign", "Just Jump In", "Quit"];

  useInput((input, key) => {
    // Campaign select sub-menu
    if (menuOpen && campaigns.length > 0) {
      if (key.upArrow) {
        setCampaignSelectIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setCampaignSelectIndex((i) => Math.min(campaigns.length - 1, i + 1));
        return;
      }
      if (key.return) {
        setMenuOpen(false);
        onResumeCampaign(campaigns[campaignSelectIndex]);
        return;
      }
      if (key.escape) {
        setMenuOpen(false);
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
        setMenuOpen(true);
        setCampaignSelectIndex(0);
      } else if (selected === "Just Jump In") {
        onJumpIn();
      } else if (selected === "Quit") {
        process.exit(0);
      }
      return;
    }
    if (input === "q" || input === "Q") {
      process.exit(0);
    }
  });

  // Campaign select sub-menu
  if (menuOpen && campaigns.length > 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Continue Campaign</Text>
        <Text> </Text>
        {campaigns.map((c, i) => (
          <Text key={c.name}>
            {i === campaignSelectIndex ? ">" : " "} {c.name}
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>Arrow keys to select, Enter to load, ESC to go back.</Text>
      </Box>
    );
  }

  const mainMenuDescriptions: Record<string, string> = {
    "New Campaign": "Full guided setup",
    "Continue Campaign": `${campaigns.length} saved`,
    "Just Jump In": "Quick start with defaults",
    "Quit": "",
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>TUI-RPG</Text>
      <Text> </Text>
      {mainMenuItems.map((item, i) => (
        <Text key={item}>
          {i === mainMenuIndex ? ">" : " "} {item}
          {mainMenuDescriptions[item] ? <Text dimColor> — {mainMenuDescriptions[item]}</Text> : null}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>Arrow keys to select, Enter to confirm.</Text>
      {errorMsg && <Text color="red">{errorMsg}</Text>}
    </Box>
  );
}
