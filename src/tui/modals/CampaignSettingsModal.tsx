import React from "react";
import type { ResolvedTheme } from "../themes/types.js";
import type { CampaignConfig } from "../../types/config.js";
import { CenteredModal } from "./CenteredModal.js";

export interface CampaignSettingsModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  config: CampaignConfig;
  onDismiss: () => void;
}

/**
 * Read-only campaign settings displayed from the ESC menu.
 * Shows campaign identity fields from config.json.
 */
export function CampaignSettingsModal({
  theme,
  width,
  height,
  config,
  onDismiss,
}: CampaignSettingsModalProps) {
  const lines: string[] = [];

  lines.push(`  Campaign:   ${config.name}`);
  if (config.system) lines.push(`  System:     ${config.system}`);
  if (config.genre) lines.push(`  Genre:      ${config.genre}`);
  if (config.mood) lines.push(`  Mood:       ${config.mood}`);
  if (config.difficulty) lines.push(`  Difficulty: ${config.difficulty}`);

  return (
    <CenteredModal
      theme={theme}
      width={width}
      height={height}
      title="Campaign Settings"
      lines={lines}
      footer="ESC to close"
      onDismiss={onDismiss}
      scrollKeys
    />
  );
}
