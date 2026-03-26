import React, { useState } from "react";
import { useInput } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { CenteredModal } from "./CenteredModal.js";
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

  const deleteLabel = selectedIndex === 0 ? "[Delete]" : " Delete ";
  const cancelLabel = selectedIndex === 1 ? "[Cancel]" : " Cancel ";

  const lines = [
    `Campaign: ${info.campaignName}`,
    `Characters: ${characters}`,
    `DM turns: ~${info.dmTurnCount} ${turnLabel}`,
    "",
    "This cannot be undone.",
    "",
    `${deleteLabel}   ${cancelLabel}`,
  ];

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Delete Campaign?"
      lines={lines}
      minWidth={36}
      maxWidth={50}
    />
  );
}
