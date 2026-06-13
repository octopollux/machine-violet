import React, { useState, useEffect } from "react";
import { useInput, Text, Box, useWindowSize } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { TerminalTooSmall, FullScreenFrame } from "../tui/components/index.js";
import { DeleteCampaignModal } from "../tui/modals/index.js";
import type { CampaignDeleteInfo } from "../tui/modals/DeleteCampaignModal.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { themeColor } from "../tui/themes/color-resolve.js";

// Types inlined to avoid importing from engine config modules
export interface CampaignEntry {
  name: string;
  path: string;
  id?: string;
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
  devModeEnabled,
  onQuit,
}: MainMenuPhaseProps) {
  const { columns: cols, rows: termRows } = useWindowSize();
  const [mainMenuIndex, setMainMenuIndex] = useState(0);
  const [expandedCampaigns, setExpandedCampaigns] = useState(false);
  const [campaignSelectIndex, setCampaignSelectIndex] = useState(0);
  /** Which column is active: 0=name (resume), 1=archive, 2=delete */
  const [campaignColumn, setCampaignColumn] = useState(COL_NAME);

  const mainMenuItems: string[] = [];
  mainMenuItems.push("New Campaign");
  if (campaigns.length > 0) mainMenuItems.push("Continue Campaign");
  if (devModeEnabled) mainMenuItems.push("Add Content");
  if (!apiKeyValid) mainMenuItems.push("API Keys");
  mainMenuItems.push("Settings");
  mainMenuItems.push("Quit");

  // Clamp selection when the menu shrinks (e.g. devModeEnabled toggled off async)
  useEffect(() => {
    setMainMenuIndex((i) => Math.min(i, mainMenuItems.length - 1));
  }, [mainMenuItems.length]);

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
        if (campaignSelectIndex === campaigns.length - 1) {
          // Scrolling past the end collapses the list and advances to the
          // main-menu item below "Continue Campaign" — the mirror of the
          // up-arrow collapse at the top. Together they make the sub-list
          // feel woven into the parent menu rather than a trap you can
          // only back out of the way you came in.
          setExpandedCampaigns(false);
          setCampaignColumn(COL_NAME);
          const continueIndex = mainMenuItems.indexOf("Continue Campaign");
          setMainMenuIndex(Math.min(mainMenuItems.length - 1, continueIndex + 1));
        } else {
          setCampaignSelectIndex((i) => i + 1);
        }
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
      if (selected === "New Campaign") {
        onNewCampaign();
      } else if (selected === "Continue Campaign") {
        setExpandedCampaigns(true);
        setCampaignSelectIndex(0);
        setCampaignColumn(COL_NAME);
      } else if (selected === "Add Content") {
        onAddContent();
      } else if (selected === "API Keys") {
        onSettingsApiKeys();
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

  const accentColor = themeColor(theme, "title") ?? themeColor(theme, "border");
  const dimColor = themeColor(theme, "separator") ?? "#666666";

  // Build menu lines
  const menuLines: React.ReactNode[] = [];
  // Render the "why disabled" hint only once — under the first disabled
  // item — to avoid repeating the same nudge on three consecutive lines.
  let disabledHintShown = false;
  for (let i = 0; i < mainMenuItems.length; i++) {
    const item = mainMenuItems[i];
    const isSelected = !expandedCampaigns && i === mainMenuIndex;
    const disabled = isItemDisabled(item);
    const marker = isSelected ? "◆" : "○";
    const markerColor = disabled ? "#555555" : isSelected ? accentColor : dimColor;

    // API Keys appears in the main menu only when the active key is
    // broken — colour it yellow so the eye lands on the actionable nudge.
    const isApiKeyNudge = item === "API Keys";
    const emphasis = isApiKeyNudge;
    let description = "";
    if (item === "New Campaign") description = "Start a new adventure";
    else if (item === "Continue Campaign" && campaigns.length > 0) description = `${campaigns.length} saved`;
    else if (item === "Add Content") description = "Import PDFs for game systems";
    else if (item === "API Keys") description = apiKeyStatus ?? "";
    else if (item === "Settings") description = "";

    const itemColor = emphasis ? "yellow" : isSelected && !disabled ? accentColor : disabled ? "#555555" : undefined;
    const descColor = emphasis ? "yellow" : disabled ? "#555555" : dimColor;
    menuLines.push(
      <Text key={item}>
        <Text color={emphasis ? "yellow" : markerColor}>{marker}</Text>
        <Text color={itemColor} dimColor={disabled} bold={emphasis || (isSelected && !disabled)}>{` ${item}`}</Text>
        {description ? <Text color={descColor} dimColor={disabled}>{` — ${description}`}</Text> : null}
      </Text>,
    );

    // Surface the underlying reason once, beneath the first disabled item.
    // Only the API-key gate exists today; if more gates appear, branch here.
    if (disabled && !disabledHintShown) {
      disabledHintShown = true;
      menuLines.push(
        <Text key={`${item}-hint`} color="#555555">
          {`   ↳ Requires a valid API key`}
        </Text>,
      );
    }

    // Inline campaign sub-list when expanded (columns: Name | Archive | Delete)
    if (item === "Continue Campaign" && expandedCampaigns) {
      for (let j = 0; j < campaigns.length; j++) {
        const cSelected = j === campaignSelectIndex;
        const nameActive = cSelected && campaignColumn === COL_NAME;
        const archiveActive = cSelected && campaignColumn === COL_ARCHIVE;
        const deleteActive = cSelected && campaignColumn === COL_DELETE;
        const cMarker = nameActive ? "◆" : "○";
        const cColor = nameActive ? accentColor : dimColor;
        menuLines.push(
          <Text key={`c-${campaigns[j].path}`}>
            <Text>{`    `}</Text>
            <Text color={cColor}>{cMarker}</Text>
            <Text color={nameActive ? accentColor : undefined} bold={nameActive}>{` ${campaigns[j].name}`}</Text>
            <Text>{`  `}</Text>
            <Text color="yellow" bold={archiveActive} dimColor={!cSelected}>{archiveActive ? "[Archive]" : " Archive "}</Text>
            <Text>{` `}</Text>
            <Text color="red" bold={deleteActive} dimColor={!cSelected}>{deleteActive ? "[Delete]" : " Delete "}</Text>
          </Text>,
        );
      }
    }
  }

  // Error banner pinned to the top via FullScreenFrame's `topBanner` slot
  // so toggling it on/off doesn't shift the centered menu. We wrap by word
  // to a fraction of the interior — caps at 80 cols to keep lines readable
  // on very wide terminals — and pass the wrapped row count to the frame
  // so its top-padding math knows how much room the banner consumes.
  const sideWidth = theme.asset.components.edge_left.width;
  const errorWrapWidth = Math.max(20, Math.min(80, cols - sideWidth * 2 - 4));
  const errorLines = errorMsg ? wrapByWord(errorMsg, errorWrapWidth) : [];
  const errorBanner = errorLines.length > 0 ? (
    <Box flexDirection="column" width={errorWrapWidth}>
      {errorLines.map((line, idx) => (
        <Text key={idx} color="red">{line}</Text>
      ))}
    </Box>
  ) : null;

  return (
    <>
      <FullScreenFrame
        theme={theme}
        columns={cols}
        rows={termRows}
        title="Machine Violet"
        contentRows={menuLines.length}
        starfield
        topBanner={errorBanner}
        topBannerRows={errorLines.length}
      >
        {menuLines}
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

/**
 * Word-wrap `text` to a maximum line width.
 *
 * Splits on whitespace and packs greedily. Words longer than `width` are
 * emitted on their own line — better to overflow one line than to split a
 * URL or path token across two and confuse a user trying to copy it. The
 * caller uses the returned line count to size the FullScreenFrame's
 * `contentRows`, so the math has to match what gets rendered.
 *
 * Inlined here (rather than pulled from a util) to keep MainMenuPhase
 * self-contained — it's the only caller, and the behavior is small
 * enough that a dedicated module would be more friction than reuse.
 */
export function wrapByWord(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
