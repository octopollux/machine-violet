import React, { useState, useEffect, useRef, useMemo } from "react";
import { useInput, Text, useWindowSize } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { TerminalTooSmall, FullScreenFrame } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { themeColor } from "../tui/themes/color-resolve.js";

const noop = () => { /* no-op */ };

export interface SettingsPhaseProps {
  theme: ResolvedTheme;
  /** When set, the phase immediately navigates to a sub-screen on mount. */
  initialView?: "api_keys";
  devModeEnabled?: boolean;
  onToggleDevMode?: () => void;
  showVerbose?: boolean;
  onToggleVerbose?: () => void;
  onApiKeys: () => void;
  onDiscord: () => void;
  onArchivedCampaigns: () => void;
  onBack: () => void;
}

interface MenuItem {
  label: string;
  /** For toggles, shows current state. */
  toggle?: boolean;
  action: () => void;
}

export function SettingsPhase({
  theme,
  initialView,
  devModeEnabled,
  onToggleDevMode,
  showVerbose,
  onToggleVerbose,
  onApiKeys,
  onDiscord,
  onArchivedCampaigns,
  onBack,
}: SettingsPhaseProps) {
  const { columns: cols, rows: termRows } = useWindowSize();
  const [menuIndex, setMenuIndex] = useState(0);
  const navigatedRef = useRef(false);

  const items: MenuItem[] = useMemo(() => [
    { label: "API Keys", action: onApiKeys },
    { label: "Discord", action: onDiscord },
    { label: "Archived Campaigns", action: onArchivedCampaigns },
    { label: "Enable Dev Mode", toggle: devModeEnabled ?? false, action: onToggleDevMode ?? noop },
    { label: "Show Debug Info", toggle: showVerbose ?? false, action: onToggleVerbose ?? noop },
  ], [onApiKeys, onDiscord, onArchivedCampaigns, devModeEnabled, onToggleDevMode, showVerbose, onToggleVerbose]);

  // Deep-link: if initialView is set, navigate once on mount
  useEffect(() => {
    if (initialView === "api_keys" && !navigatedRef.current) {
      navigatedRef.current = true;
      onApiKeys();
    }
  }, [initialView, onApiKeys, onDiscord]);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setMenuIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setMenuIndex((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (key.return) {
      items[menuIndex].action();
    }
  });

  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  const borderColor = themeColor(theme, "border");
  const dimColor = themeColor(theme, "separator") ?? "#666666";

  const menuLines: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isSelected = i === menuIndex;
    const marker = isSelected ? "◆" : "○";
    const markerColor = isSelected ? borderColor : dimColor;

    const suffix = item.toggle !== undefined
      ? item.toggle ? "  ON" : "  OFF"
      : "";

    menuLines.push(
      <Text key={item.label}>
        <Text color={markerColor}>{marker}</Text>
        <Text>{` ${item.label}`}</Text>
        {suffix && <Text color={item.toggle ? "#66cc66" : dimColor} bold={item.toggle}>{suffix}</Text>}
      </Text>,
    );
  }

  return (
    <FullScreenFrame theme={theme} columns={cols} rows={termRows} title="Settings" contentRows={menuLines.length}>
      {menuLines}
    </FullScreenFrame>
  );
}
