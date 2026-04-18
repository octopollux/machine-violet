import React, { useState } from "react";
import { useInput, Text, useWindowSize } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { TerminalTooSmall, FullScreenFrame } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { themeColor } from "../tui/themes/color-resolve.js";
import type { ArchivedCampaignEntry } from "../config/campaign-archive.js";

export interface ArchivedCampaignsPhaseProps {
  theme: ResolvedTheme;
  archives: ArchivedCampaignEntry[];
  onUnarchive: (entry: ArchivedCampaignEntry) => void;
  onBack: () => void;
  statusMessage?: string;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

export function ArchivedCampaignsPhase({
  theme,
  archives,
  onUnarchive,
  onBack,
  statusMessage,
}: ArchivedCampaignsPhaseProps) {
  const { columns: cols, rows: termRows } = useWindowSize();
  const [menuIndex, setMenuIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (archives.length === 0) return;
    if (key.upArrow) {
      setMenuIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setMenuIndex((i) => Math.min(archives.length - 1, i + 1));
      return;
    }
    if (key.return && archives.length > 0) {
      onUnarchive(archives[menuIndex]);
    }
  });

  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  const borderColor = themeColor(theme, "border");
  const dimColor = themeColor(theme, "separator") ?? "#666666";

  const menuLines: React.ReactNode[] = [];

  if (statusMessage) {
    menuLines.push(
      <Text key="status" color="#66cc66">{statusMessage}</Text>,
    );
    menuLines.push(
      <Text key="status-spacer">{" "}</Text>,
    );
  }

  if (archives.length === 0) {
    menuLines.push(
      <Text key="empty" color={dimColor}>No archived campaigns.</Text>,
    );
  } else {
    for (let i = 0; i < archives.length; i++) {
      const entry = archives[i];
      const isSelected = i === menuIndex;
      const marker = isSelected ? "◆" : "○";
      const markerColor = isSelected ? borderColor : dimColor;
      const dateStr = formatDate(entry.archivedDate);

      menuLines.push(
        <Text key={entry.zipPath}>
          <Text color={markerColor}>{marker}</Text>
          <Text bold={isSelected}>{` ${entry.name}`}</Text>
          <Text color={dimColor}>{`  Archived ${dateStr}`}</Text>
        </Text>,
      );
    }
  }

  menuLines.push(
    <Text key="spacer">{" "}</Text>,
  );
  menuLines.push(
    <Text key="hint" color={dimColor}>{"  Enter to restore  ·  Esc to go back"}</Text>,
  );

  return (
    <FullScreenFrame
      theme={theme}
      columns={cols}
      rows={termRows}
      title="Archived Campaigns"
      contentRows={menuLines.length}
    >
      {menuLines}
    </FullScreenFrame>
  );
}
