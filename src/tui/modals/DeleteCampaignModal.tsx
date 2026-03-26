import React, { useState } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";
import { themeColor } from "../themes/color-resolve.js";
import type { CampaignDeleteInfo } from "../../config/campaign-archive.js";

export interface DeleteCampaignModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  info: CampaignDeleteInfo;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteCampaignModal({
  theme,
  width,
  height,
  info,
  onConfirm,
  onCancel,
}: DeleteCampaignModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(1); // default to Cancel
  const borderColor = themeColor(theme, "border");
  const dimColor = themeColor(theme, "separator") ?? "#666666";

  const options = ["Delete", "Cancel"];

  useInput((_input, key) => {
    if (key.leftArrow || key.rightArrow) {
      setSelectedIndex((i) => (i === 0 ? 1 : 0));
      return;
    }
    if (key.return) {
      if (selectedIndex === 0) onConfirm();
      else onCancel();
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  const characters = info.characterNames.length > 0
    ? info.characterNames.join(", ")
    : "(none)";

  const turnLabel = info.dmTurnCount === 1 ? "turn" : "turns";

  const contentLines = [
    `Campaign: ${info.campaignName}`,
    `Characters: ${characters}`,
    `DM turns: ~${info.dmTurnCount} ${turnLabel}`,
    "",
    "This cannot be undone.",
  ];

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Delete Campaign?"
      minWidth={36}
      maxWidth={50}
    >
      {contentLines.map((line, i) => (
        <Text key={i} color={line === "This cannot be undone." ? "red" : undefined}>{line || " "}</Text>
      ))}
      <Text>{" "}</Text>
      <Text>
        {options.map((opt, i) => {
          const active = i === selectedIndex;
          const color = opt === "Delete" ? "red" : undefined;
          const markerColor = active ? borderColor : dimColor;
          return (
            <Text key={opt}>
              <Text color={markerColor}>{active ? "◆" : "○"}</Text>
              <Text color={color} bold={active}>{` ${opt}`}</Text>
              {i < options.length - 1 ? <Text>{"   "}</Text> : null}
            </Text>
          );
        })}
      </Text>
    </CenteredModal>
  );
}
