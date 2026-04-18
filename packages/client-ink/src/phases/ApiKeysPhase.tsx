import React, { useState, useEffect, useCallback, useRef } from "react";
import { useInput, Text, Box, useWindowSize } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { useTextInput } from "../tui/hooks/useTextInput.js";
import { themeColor } from "../tui/themes/color-resolve.js";
import { validateApiKeyFormat } from "../config/first-launch.js";
import {
  maskKey, addKey as addKeyToStore, removeKey as removeKeyFromStore, setActiveKey,
} from "../config/api-keys.js";
import type { ApiKeyStore } from "../config/api-keys.js";
import type { KeyHealthResult } from "../config/api-key-health.js";
import { formatRateLimits } from "../config/api-key-health.js";

// ---------------------------------------------------------------------------
// Sub-modes within the phase
// ---------------------------------------------------------------------------

type SubMode =
  | { kind: "list" }
  | { kind: "add_key" }
  | { kind: "add_label" }
  | { kind: "confirm_delete"; keyId: string; label: string };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ApiKeysPhaseProps {
  theme: ResolvedTheme;
  store: ApiKeyStore;
  healthResults: Record<string, KeyHealthResult>;
  onUpdateStore: (store: ApiKeyStore) => void;
  onCheckHealth: (keyId: string, apiKey: string) => void;
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApiKeysPhase({
  theme,
  store,
  healthResults,
  onUpdateStore,
  onCheckHealth,
  onBack,
}: ApiKeysPhaseProps) {
  const { columns: cols, rows: termRows } = useWindowSize();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [subMode, setSubMode] = useState<SubMode>({ kind: "list" });

  // Text input state for adding keys
  const [newKeyInput, setNewKeyInput] = useState("");
  const [newLabelInput, setNewLabelInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const { handleKey: handleKeyInput } = useTextInput({ value: newKeyInput, onChange: setNewKeyInput });
  const { handleKey: handleLabelInput } = useTextInput({ value: newLabelInput, onChange: setNewLabelInput });

  // Auto-check health for keys without results (fires when store populates)
  const checkedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of store.keys) {
      if (!healthResults[entry.id] && !checkedRef.current.has(entry.id)) {
        checkedRef.current.add(entry.id);
        onCheckHealth(entry.id, entry.key);
      }
    }
  }, [store.keys, healthResults, onCheckHealth]);

  // Clamp selected index when keys change
  useEffect(() => {
    if (selectedIndex >= store.keys.length && store.keys.length > 0) {
      setSelectedIndex(store.keys.length - 1);
    }
  }, [store.keys.length, selectedIndex]);

  const addKey = useCallback((key: string, label: string) => {
    const updated = addKeyToStore(store, key, label);
    onUpdateStore(updated);
    const newEntry = updated.keys[updated.keys.length - 1];
    onCheckHealth(newEntry.id, newEntry.key);
  }, [store, onUpdateStore, onCheckHealth]);

  const removeKey = useCallback((keyId: string) => {
    onUpdateStore(removeKeyFromStore(store, keyId));
  }, [store, onUpdateStore]);

  const selectKey = useCallback((keyId: string) => {
    onUpdateStore(setActiveKey(store, keyId));
  }, [store, onUpdateStore]);

  // --- Input handling ---
  useInput((input, key) => {
    // Add key mode: entering API key
    if (subMode.kind === "add_key") {
      if (key.escape) {
        setSubMode({ kind: "list" });
        setNewKeyInput("");
        setInputError(null);
        return;
      }
      if (key.return) {
        const trimmed = newKeyInput.trim();
        if (!validateApiKeyFormat(trimmed)) {
          setInputError("Invalid key format (expected sk-ant-...)");
          return;
        }
        // Check for duplicates
        if (store.keys.some((k) => k.key === trimmed)) {
          setInputError("This key is already in the list");
          return;
        }
        setInputError(null);
        setSubMode({ kind: "add_label" });
        return;
      }
      handleKeyInput(input, key);
      return;
    }

    // Add label mode: entering label for new key
    if (subMode.kind === "add_label") {
      if (key.escape) {
        setSubMode({ kind: "add_key" });
        setNewLabelInput("");
        return;
      }
      if (key.return) {
        addKey(newKeyInput.trim(), newLabelInput.trim());
        setNewKeyInput("");
        setNewLabelInput("");
        setSubMode({ kind: "list" });
        return;
      }
      handleLabelInput(input, key);
      return;
    }

    // Confirm delete mode
    if (subMode.kind === "confirm_delete") {
      if (input === "y" || input === "Y") {
        removeKey(subMode.keyId);
        setSubMode({ kind: "list" });
        return;
      }
      // Any other key cancels
      setSubMode({ kind: "list" });
      return;
    }

    // List mode
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow && store.keys.length > 0) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow && store.keys.length > 0) {
      setSelectedIndex((i) => Math.min(store.keys.length - 1, i + 1));
      return;
    }
    if (key.return && store.keys.length > 0) {
      const entry = store.keys[selectedIndex];
      selectKey(entry.id);
      return;
    }
    if ((input === "a" || input === "A") && subMode.kind === "list") {
      setSubMode({ kind: "add_key" });
      setNewKeyInput("");
      setNewLabelInput("");
      setInputError(null);
      return;
    }
    if ((input === "d" || input === "D") && store.keys.length > 0) {
      const entry = store.keys[selectedIndex];
      if (entry.source === "env") return; // can't delete env key
      setSubMode({ kind: "confirm_delete", keyId: entry.id, label: entry.label });
      return;
    }
    if ((input === "r" || input === "R") && store.keys.length > 0) {
      const entry = store.keys[selectedIndex];
      onCheckHealth(entry.id, entry.key);
      return;
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

  // --- Build display lines ---
  const displayLines: React.ReactNode[] = [];

  // Key list
  for (let i = 0; i < store.keys.length; i++) {
    const entry = store.keys[i];
    const isSelected = subMode.kind === "list" && i === selectedIndex;
    const isActive = entry.id === store.activeKeyId;
    const health = healthResults[entry.id];

    const marker = isSelected ? ">" : " ";
    const activeMarker = isActive ? "*" : " ";
    const statusIcon = healthStatusIcon(health);
    const masked = maskKey(entry.key);

    displayLines.push(
      <Text key={entry.id}>
        <Text color={isSelected ? borderColor : dimColor}>{marker}</Text>
        <Text color={isActive ? "greenBright" : dimColor}>{activeMarker}</Text>
        <Text>{` ${entry.label}`}</Text>
        <Text dimColor>{`  ${masked}`}</Text>
        <Text>{`  `}</Text>
        <Text color={healthStatusColor(health)}>{statusIcon}</Text>
      </Text>,
    );

    // Show rate limit info for selected key
    if (isSelected && health?.rateLimits) {
      const rl = formatRateLimits(health.rateLimits);
      if (rl !== "No rate limit data") {
        displayLines.push(
          <Text key={`rl-${entry.id}`} dimColor>{`     Rate limits: ${rl}`}</Text>,
        );
      }
    }
  }

  if (store.keys.length === 0) {
    displayLines.push(<Text key="empty" dimColor>No API keys configured</Text>);
  }

  // Spacer
  displayLines.push(<Text key="spacer"> </Text>);

  // Sub-mode specific content
  if (subMode.kind === "add_key") {
    displayLines.push(<Text key="add-prompt">Paste API key:</Text>);
    displayLines.push(
      <Text key="add-input">
        {"  > "}
        {newKeyInput.length > 0 ? newKeyInput.slice(0, 10) + "..." + newKeyInput.slice(-4) : "_"}
      </Text>,
    );
    if (inputError) {
      displayLines.push(<Text key="add-error" color="red">{inputError}</Text>);
    }
    displayLines.push(<Text key="add-hint" dimColor>Enter to continue · Esc to cancel</Text>);
  } else if (subMode.kind === "add_label") {
    displayLines.push(<Text key="label-prompt">Label for this key (optional):</Text>);
    displayLines.push(
      <Text key="label-input">{"  > "}{newLabelInput || "_"}</Text>,
    );
    displayLines.push(<Text key="label-hint" dimColor>Enter to save · Esc to go back</Text>);
  } else if (subMode.kind === "confirm_delete") {
    displayLines.push(
      <Text key="confirm" color="red">
        {`Delete "${subMode.label}"? (y/N)`}
      </Text>,
    );
  } else {
    // Footer hints
    displayLines.push(
      <Text key="hints" dimColor>
        {store.keys.length > 0
          ? "Enter = activate · A = add · D = delete · R = recheck · Esc = back"
          : "A = add key · Esc = back"}
      </Text>,
    );
  }

  // Center vertically
  const menuHeight = displayLines.length;
  const topPad = Math.max(0, Math.floor((contentHeight - menuHeight) / 2));
  const bottomPad = Math.max(0, contentHeight - menuHeight - topPad);

  return (
    <Box flexDirection="column" width={cols} height={termRows}>
      <ThemedHorizontalBorder theme={theme} width={cols} position="top" centerText="API Keys" />
      <Box flexDirection="row" height={contentHeight}>
        <ThemedSideFrame theme={theme} side="left" height={contentHeight} />
        <Box flexDirection="column" width={contentWidth} alignItems="center">
          {topPad > 0 && <Box height={topPad} />}
          <Box flexDirection="column" alignItems="flex-start">
            {displayLines}
          </Box>
          {bottomPad > 0 && <Box height={bottomPad} />}
        </Box>
        <ThemedSideFrame theme={theme} side="right" height={contentHeight} />
      </Box>
      <ThemedHorizontalBorder theme={theme} width={cols} position="bottom" />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function healthStatusIcon(health: KeyHealthResult | undefined): string {
  if (!health) return "...";
  switch (health.status) {
    case "valid": return "Valid";
    case "invalid": return "Invalid";
    case "rate_limited": return "Rate limited";
    case "error": return "Error";
    case "checking": return "Checking...";
  }
}

function healthStatusColor(health: KeyHealthResult | undefined): string {
  if (!health) return "gray";
  switch (health.status) {
    case "valid": return "greenBright";
    case "invalid": return "red";
    case "rate_limited": return "yellowBright";
    case "error": return "red";
    case "checking": return "gray";
  }
}
