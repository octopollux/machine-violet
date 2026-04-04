import React, { useState, useRef, useEffect } from "react";
import { useInput, Text, Box } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { TerminalTooSmall, FullScreenFrame } from "../tui/components/index.js";
import { DeleteCampaignModal } from "../tui/modals/index.js";
import type { CampaignDeleteInfo } from "../tui/modals/DeleteCampaignModal.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { themeColor } from "../tui/themes/color-resolve.js";

// Types inlined to avoid importing from engine config modules
export interface CampaignEntry {
  name: string;
  path: string;
  id?: string;
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
}

/** Column indices for campaign sub-list navigation. */
const COL_NAME = 0;
const COL_ARCHIVE = 1;
const COL_DELETE = 2;
const COL_COUNT = 3;

export interface MainMenuPhaseProps {
  theme: ResolvedTheme;
  campaigns: CampaignEntry[];
  errorMsg: string | null;
  /** Whether the active API key passed its health check. */
  apiKeyValid: boolean;
  /** Short status text for the active key (e.g. "Valid", "Invalid"). */
  apiKeyStatus?: string;
  onNewCampaign: () => void;
  onResumeCampaign: (entry: CampaignEntry) => void;
  onArchiveCampaign: (entry: CampaignEntry) => void;
  onDeleteCampaign: (entry: CampaignEntry) => void;
  /** When non-null, the delete confirmation modal is shown. */
  deleteModal: CampaignDeleteInfo | null;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onAddContent: () => void;
  onSettings: () => void;
  /** Navigate to Settings with API Keys pre-focused (deep link). */
  onSettingsApiKeys: () => void;
  /** Update info when a newer version is available. */
  updateInfo?: UpdateInfo | null;
  /** Navigate to the update detail screen. */
  onUpdate?: () => void;
  /** Whether the Discord Rich Presence setting has not been configured yet. */
  discordSettingUnset?: boolean;
  /** Navigate to Discord Rich Presence settings. */
  onDiscordSettings?: () => void;
  /** Whether Dev Mode is enabled (gates advanced features like content ingest). */
  devModeEnabled?: boolean;
  onQuit: () => void;
}

/** Items that require a valid API key to select. */
const API_REQUIRED_ITEMS = new Set(["New Campaign", "Continue Campaign", "Add Content"]);

export function MainMenuPhase({
  theme,
  campaigns,
  errorMsg,
  apiKeyValid,
  apiKeyStatus,
  onNewCampaign,
  onResumeCampaign,
  onArchiveCampaign,
  onDeleteCampaign,
  deleteModal,
  onConfirmDelete,
  onCancelDelete,
  onAddContent,
  onSettings,
  onSettingsApiKeys,
  updateInfo,
  onUpdate,
  discordSettingUnset,
  onDiscordSettings,
  devModeEnabled,
  onQuit,
}: MainMenuPhaseProps) {
  const { columns: cols, rows: termRows } = useTerminalSize();
  const [mainMenuIndex, setMainMenuIndex] = useState(0);
  const [expandedCampaigns, setExpandedCampaigns] = useState(false);
  const [campaignSelectIndex, setCampaignSelectIndex] = useState(0);
  /** Which column is active: 0=name (resume), 1=archive, 2=delete */
  const [campaignColumn, setCampaignColumn] = useState(COL_NAME);

  // Track whether the update item was present on previous render so we can
  // adjust mainMenuIndex when it appears asynchronously (avoids highlight jump).
  const showUpdateItem = !!(updateInfo?.available && onUpdate);
  const hadUpdateItem = useRef(showUpdateItem);
  useEffect(() => {
    if (showUpdateItem && !hadUpdateItem.current) {
      // Update item just appeared mid-session — bump index so the user's selection stays put
      setMainMenuIndex((i) => i + 1);
    }
    hadUpdateItem.current = showUpdateItem;
  }, [showUpdateItem]);

  const mainMenuItems: string[] = [];
  if (showUpdateItem) mainMenuItems.push("Update Available");
  mainMenuItems.push("New Campaign");
  if (campaigns.length > 0) mainMenuItems.push("Continue Campaign");
  if (devModeEnabled) mainMenuItems.push("Add Content");
  if (!apiKeyValid) mainMenuItems.push("API Keys");
  if (discordSettingUnset) mainMenuItems.push("Discord");
  mainMenuItems.push("Settings");
  mainMenuItems.push("Quit");

  const isItemDisabled = (item: string): boolean =>
    API_REQUIRED_ITEMS.has(item) && !apiKeyValid;

  useInput((input, key) => {
    // Delete modal is handling its own input — suppress menu navigation
    if (deleteModal) return;

    // Campaign sub-list navigation (columns: Name | Archive | Delete)
    if (expandedCampaigns && campaigns.length > 0) {
      if (key.upArrow) {
        if (campaignSelectIndex === 0) {
          setExpandedCampaigns(false);
          setCampaignColumn(COL_NAME);
        } else {
          setCampaignSelectIndex((i) => i - 1);
        }
        return;
      }
      if (key.downArrow) {
        setCampaignSelectIndex((i) => Math.min(campaigns.length - 1, i + 1));
        return;
      }
      if (key.rightArrow) {
        setCampaignColumn((c) => Math.min(COL_COUNT - 1, c + 1));
        return;
      }
      if (key.leftArrow) {
        setCampaignColumn((c) => Math.max(0, c - 1));
        return;
      }
      if (key.return) {
        const entry = campaigns[campaignSelectIndex];
        if (campaignColumn === COL_NAME) {
          setExpandedCampaigns(false);
          setCampaignColumn(COL_NAME);
          onResumeCampaign(entry);
        } else if (campaignColumn === COL_ARCHIVE) {
          onArchiveCampaign(entry);
          setExpandedCampaigns(false);
          setCampaignColumn(COL_NAME);
        } else if (campaignColumn === COL_DELETE) {
          onDeleteCampaign(entry);
        }
        return;
      }
      if (key.escape) {
        setExpandedCampaigns(false);
        setCampaignColumn(COL_NAME);
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
      if (isItemDisabled(selected)) return; // blocked
      if (selected === "Update Available") {
        onUpdate?.();
      } else if (selected === "New Campaign") {
        onNewCampaign();
      } else if (selected === "Continue Campaign") {
        setExpandedCampaigns(true);
        setCampaignSelectIndex(0);
        setCampaignColumn(COL_NAME);
      } else if (selected === "Add Content") {
        onAddContent();
      } else if (selected === "API Keys") {
        onSettingsApiKeys();
      } else if (selected === "Discord") {
        onDiscordSettings?.();
      } else if (selected === "Settings") {
        onSettings();
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

  // Build menu lines
  const menuLines: React.ReactNode[] = [];
  for (let i = 0; i < mainMenuItems.length; i++) {
    const item = mainMenuItems[i];
    const isSelected = !expandedCampaigns && i === mainMenuIndex;
    const disabled = isItemDisabled(item);
    const marker = isSelected ? "◆" : "○";
    const markerColor = disabled ? "#555555" : isSelected ? borderColor : dimColor;

    const isUpdateItem = item === "Update Available";
    let description = "";
    if (isUpdateItem && updateInfo) description = `v${updateInfo.currentVersion} → v${updateInfo.latestVersion}`;
    else if (item === "New Campaign") description = "Start a new adventure";
    else if (item === "Continue Campaign" && campaigns.length > 0) description = `${campaigns.length} saved`;
    else if (item === "Add Content") description = "Import PDFs for game systems";
    else if (item === "API Keys") description = apiKeyStatus ?? "";
    else if (item === "Discord") description = "Set up Rich Presence";
    else if (item === "Settings") description = "";

    const itemColor = isUpdateItem ? "yellow" : disabled ? "#555555" : undefined;
    const descColor = isUpdateItem ? "yellow" : disabled ? "#555555" : dimColor;
    menuLines.push(
      <Text key={item}>
        <Text color={isUpdateItem ? "yellow" : markerColor}>{marker}</Text>
        <Text color={itemColor} dimColor={disabled} bold={isUpdateItem}>{` ${item}`}</Text>
        {description ? <Text color={descColor} dimColor={disabled}>{` — ${description}`}</Text> : null}
      </Text>,
    );

    // Inline campaign sub-list when expanded (columns: Name | Archive | Delete)
    if (item === "Continue Campaign" && expandedCampaigns) {
      for (let j = 0; j < campaigns.length; j++) {
        const cSelected = j === campaignSelectIndex;
        const nameActive = cSelected && campaignColumn === COL_NAME;
        const archiveActive = cSelected && campaignColumn === COL_ARCHIVE;
        const deleteActive = cSelected && campaignColumn === COL_DELETE;
        const cMarker = nameActive ? "◆" : "○";
        const cColor = nameActive ? borderColor : dimColor;
        menuLines.push(
          <Text key={`c-${campaigns[j].path}`}>
            <Text>{`    `}</Text>
            <Text color={cColor}>{cMarker}</Text>
            <Text bold={nameActive}>{` ${campaigns[j].name}`}</Text>
            <Text>{`  `}</Text>
            <Text color="yellow" bold={archiveActive} dimColor={!cSelected}>{archiveActive ? "[Archive]" : " Archive "}</Text>
            <Text>{` `}</Text>
            <Text color="red" bold={deleteActive} dimColor={!cSelected}>{deleteActive ? "[Delete]" : " Delete "}</Text>
          </Text>,
        );
      }
    }
  }

  // +2 for error message (marginTop=1 + text line) when present
  const totalRows = menuLines.length + (errorMsg ? 2 : 0);

  return (
    <>
      <FullScreenFrame theme={theme} columns={cols} rows={termRows} title="Machine Violet" contentRows={totalRows}>
        {menuLines}
        {errorMsg && (
          <Box marginTop={1}>
            <Text color="red">{errorMsg}</Text>
          </Box>
        )}
      </FullScreenFrame>
      {deleteModal && (
        <DeleteCampaignModal
          theme={theme}
          width={cols}
          height={termRows}
          info={deleteModal}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      )}
    </>
  );
}
