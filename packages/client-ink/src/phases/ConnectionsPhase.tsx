/**
 * ConnectionsPhase — manage AI provider connections and tier assignments.
 *
 * Multi-screen navigation:
 *   Main menu → Connections list (health, delete)
 *            → Model Assignments (tier → model picker)
 *            → Add Connection (provider → key → label → baseUrl wizard)
 */
import React, { useState, useEffect, useRef } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { TerminalTooSmall, FullScreenFrame } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { useTextInput } from "../tui/hooks/useTextInput.js";
import { themeColor } from "../tui/themes/color-resolve.js";
import type {
  ConnectionInfo, TierAssignmentsResponse, TierAssignmentEntry,
  KnownModelInfo, ConnectionHealthResponse,
} from "../api-client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type Screen = "menu" | "connections" | "tiers" | "tier-pick" | "add-provider" | "add-key" | "add-label" | "add-url";

const MENU_ITEMS = ["Connections", "Model Assignments", "Add Connection"] as const;

const PROVIDER_OPTIONS = [
  { id: "anthropic", label: "Anthropic", needsBaseUrl: false },
  { id: "openai", label: "OpenAI", needsBaseUrl: false },
  { id: "openrouter", label: "OpenRouter", needsBaseUrl: false },
  { id: "custom", label: "Custom (OpenAI-compatible)", needsBaseUrl: true },
] as const;

const TIER_LABELS: Record<string, string> = {
  large: "Large (DM narration)",
  medium: "Medium (OOC, AI players)",
  small: "Small (mechanical tasks)",
};

const TIERS = ["large", "medium", "small"] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ConnectionsPhaseProps {
  theme: ResolvedTheme;
  connections: ConnectionInfo[];
  tierAssignments: TierAssignmentsResponse;
  healthResults: Record<string, ConnectionHealthResponse>;
  knownModels: Record<string, KnownModelInfo>;
  onAddConnection: (provider: string, apiKey: string, label: string, baseUrl?: string) => void;
  onRemoveConnection: (id: string) => void;
  onCheckHealth: (id: string) => void;
  onSetTier: (tier: "large" | "medium" | "small", assignment: TierAssignmentEntry) => void;
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConnectionsPhase({
  theme,
  connections,
  tierAssignments,
  healthResults,
  knownModels,
  onAddConnection,
  onRemoveConnection,
  onCheckHealth,
  onSetTier,
  onBack,
}: ConnectionsPhaseProps) {
  const { columns: cols, rows: termRows } = useTerminalSize();
  const [screen, setScreen] = useState<Screen>("menu");
  const [menuIndex, setMenuIndex] = useState(0);
  const [connIndex, setConnIndex] = useState(0);
  const [tierIndex, setTierIndex] = useState(0);
  const [tierModelIndex, setTierModelIndex] = useState(0);
  const [addProviderIndex, setAddProviderIndex] = useState(0);
  const [addProvider, setAddProvider] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const { handleKey: handleKeyInput } = useTextInput({ value: keyInput, onChange: setKeyInput });
  const { handleKey: handleLabelInput } = useTextInput({ value: labelInput, onChange: setLabelInput });
  const { handleKey: handleBaseUrlInput } = useTextInput({ value: baseUrlInput, onChange: setBaseUrlInput });

  // Auto-check health on mount
  const checkedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const conn of connections) {
      if (!healthResults[conn.id] && !checkedRef.current.has(conn.id)) {
        checkedRef.current.add(conn.id);
        onCheckHealth(conn.id);
      }
    }
  }, [connections, healthResults, onCheckHealth]);

  // Build model options for tier picking
  const allModels: { connectionId: string; modelId: string; label: string }[] = [];
  for (const conn of connections) {
    for (const m of conn.models) {
      allModels.push({ connectionId: conn.id, modelId: m.id, label: `${m.displayName} [${conn.label}]` });
    }
  }

  // --- Health helpers ---
  const healthIcon = (id: string) => {
    const h = healthResults[id];
    if (!h) return "?";
    if (h.status === "valid") return "\u2714";
    if (h.status === "rate_limited") return "\u26A0";
    if (h.status === "invalid") return "\u2718";
    return "\u2022";
  };
  const healthColor = (id: string) => {
    const h = healthResults[id];
    if (!h) return "#666666";
    if (h.status === "valid") return "#88cc88";
    if (h.status === "rate_limited") return "#cccc44";
    return "#cc4444";
  };

  const fg = "#cccccc";
  const dim = "#666666";
  const accent = themeColor(theme, "title") ?? "#ffffff";
  const border = themeColor(theme, "border");

  // --- Input ---
  useInput((input, key) => {
    // --- Main menu ---
    if (screen === "menu") {
      if (key.escape) { onBack(); return; }
      if (key.upArrow) { setMenuIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setMenuIndex((i) => Math.min(MENU_ITEMS.length - 1, i + 1)); return; }
      if (key.return) {
        if (menuIndex === 0) setScreen("connections");
        else if (menuIndex === 1) setScreen("tiers");
        else if (menuIndex === 2) { setScreen("add-provider"); setAddProviderIndex(0); }
      }
      return;
    }

    // --- Connections list ---
    if (screen === "connections") {
      if (key.escape) { setScreen("menu"); return; }
      if (key.upArrow) { setConnIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setConnIndex((i) => Math.min(connections.length - 1, i + 1)); return; }
      if (input === "r" || input === "R") {
        const conn = connections[connIndex];
        if (conn) onCheckHealth(conn.id);
        return;
      }
      if (input === "d" || input === "D") {
        const conn = connections[connIndex];
        if (conn && conn.source !== "env") {
          onRemoveConnection(conn.id);
          setConnIndex((i) => Math.max(0, i - 1));
        }
        return;
      }
      return;
    }

    // --- Tier assignments ---
    if (screen === "tiers") {
      if (key.escape) { setScreen("menu"); return; }
      if (key.upArrow) { setTierIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setTierIndex((i) => Math.min(2, i + 1)); return; }
      if (key.return && allModels.length > 0) {
        setTierModelIndex(0);
        setScreen("tier-pick");
      }
      return;
    }

    // --- Tier model picker ---
    if (screen === "tier-pick") {
      if (key.escape) { setScreen("tiers"); return; }
      if (key.upArrow) { setTierModelIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setTierModelIndex((i) => Math.min(allModels.length - 1, i + 1)); return; }
      if (key.return) {
        const model = allModels[tierModelIndex];
        if (model) onSetTier(TIERS[tierIndex], { connectionId: model.connectionId, modelId: model.modelId });
        setScreen("tiers");
      }
      return;
    }

    // --- Add: provider selection ---
    if (screen === "add-provider") {
      if (key.escape) { setScreen("menu"); return; }
      if (key.upArrow) { setAddProviderIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setAddProviderIndex((i) => Math.min(PROVIDER_OPTIONS.length - 1, i + 1)); return; }
      if (key.return) {
        setAddProvider(PROVIDER_OPTIONS[addProviderIndex].id);
        setKeyInput(""); setLabelInput(""); setBaseUrlInput("");
        setScreen("add-key");
      }
      return;
    }

    // --- Add: key input ---
    if (screen === "add-key") {
      if (key.escape) { setScreen("add-provider"); return; }
      if (key.return && keyInput.trim()) { setScreen("add-label"); return; }
      handleKeyInput(input, key);
      return;
    }

    // --- Add: label input ---
    if (screen === "add-label") {
      if (key.escape) { setScreen("add-key"); return; }
      if (key.return) {
        const needsBaseUrl = PROVIDER_OPTIONS.find((p) => p.id === addProvider)?.needsBaseUrl;
        if (needsBaseUrl) { setScreen("add-url"); } else {
          onAddConnection(addProvider, keyInput.trim(), labelInput.trim());
          setScreen("menu");
        }
        return;
      }
      handleLabelInput(input, key);
      return;
    }

    // --- Add: base URL input ---
    if (screen === "add-url") {
      if (key.escape) { setScreen("add-label"); return; }
      if (key.return && baseUrlInput.trim()) {
        onAddConnection(addProvider, keyInput.trim(), labelInput.trim(), baseUrlInput.trim());
        setScreen("menu");
      } else {
        handleBaseUrlInput(input, key);
      }
      return;
    }
  });

  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  // --- Render screens ---

  if (screen === "menu") {
    const lines: React.ReactNode[] = [];
    for (let i = 0; i < MENU_ITEMS.length; i++) {
      const selected = i === menuIndex;
      lines.push(
        <Text key={MENU_ITEMS[i]} color={selected ? border : dim}>
          {selected ? "\u25C6" : "\u25CB"}{" "}{MENU_ITEMS[i]}
        </Text>,
      );
    }
    return (
      <FullScreenFrame theme={theme} columns={cols} rows={termRows} title="AI Connections" contentRows={lines.length}>
        {lines}
      </FullScreenFrame>
    );
  }

  if (screen === "connections") {
    const lines: React.ReactNode[] = [];
    for (let i = 0; i < connections.length; i++) {
      const conn = connections[i];
      const selected = i === connIndex;
      lines.push(
        <Text key={conn.id} color={selected ? accent : fg}>
          {selected ? "\u25C6 " : "  "}
          <Text color={healthColor(conn.id)}>{healthIcon(conn.id)}</Text>
          {" "}{conn.label}
          <Text color={dim}>{" \u2014 "}{conn.provider}{conn.models.length > 0 ? ` \u00b7 ${conn.models.length} models` : ""}</Text>
        </Text>,
      );
    }
    if (connections.length === 0) {
      lines.push(<Text key="empty" color={dim}>No connections configured.</Text>);
    }
    lines.push(<Text key="help" color={dim}> </Text>);
    lines.push(<Text key="help2" color={dim}>R = recheck health  D = delete  Esc = back</Text>);
    return (
      <FullScreenFrame theme={theme} columns={cols} rows={termRows} title="Connections" contentRows={lines.length}>
        {lines}
      </FullScreenFrame>
    );
  }

  if (screen === "tiers") {
    const lines: React.ReactNode[] = [];
    for (let i = 0; i < TIERS.length; i++) {
      const tier = TIERS[i];
      const assignment = tierAssignments[tier];
      const modelName = assignment ? (knownModels[assignment.modelId]?.displayName ?? assignment.modelId) : "(not set)";
      const connLabel = assignment ? connections.find((c) => c.id === assignment.connectionId)?.label : undefined;
      const selected = i === tierIndex;
      lines.push(
        <Text key={tier} color={selected ? accent : fg}>
          {selected ? "\u25C6 " : "  "}{TIER_LABELS[tier]}
        </Text>,
      );
      lines.push(
        <Text key={`${tier}-val`} color={selected ? fg : dim}>
          {"    "}{modelName}{connLabel ? <Text color={dim}>{" ["}{connLabel}{"]"}</Text> : null}
        </Text>,
      );
    }
    lines.push(<Text key="help" color={dim}> </Text>);
    lines.push(<Text key="help2" color={dim}>Enter = change model  Esc = back</Text>);
    return (
      <FullScreenFrame theme={theme} columns={cols} rows={termRows} title="Model Assignments" contentRows={lines.length}>
        {lines}
      </FullScreenFrame>
    );
  }

  if (screen === "tier-pick") {
    const tier = TIERS[tierIndex];
    const lines: React.ReactNode[] = [];
    lines.push(<Text key="header" color={dim}>Select model for {TIER_LABELS[tier]}:</Text>);
    lines.push(<Text key="sep"> </Text>);
    for (let i = 0; i < allModels.length; i++) {
      const m = allModels[i];
      const selected = i === tierModelIndex;
      lines.push(
        <Text key={`${m.connectionId}-${m.modelId}`} color={selected ? accent : fg}>
          {selected ? "\u25C6 " : "  "}{m.label}
        </Text>,
      );
    }
    return (
      <FullScreenFrame theme={theme} columns={cols} rows={termRows} title={`Select ${tier.charAt(0).toUpperCase() + tier.slice(1)} Model`} contentRows={lines.length}>
        {lines}
      </FullScreenFrame>
    );
  }

  if (screen === "add-provider") {
    const lines: React.ReactNode[] = [];
    lines.push(<Text key="header" color={dim}>Choose provider type:</Text>);
    lines.push(<Text key="sep"> </Text>);
    for (let i = 0; i < PROVIDER_OPTIONS.length; i++) {
      const p = PROVIDER_OPTIONS[i];
      const selected = i === addProviderIndex;
      lines.push(
        <Text key={p.id} color={selected ? accent : fg}>
          {selected ? "\u25C6 " : "  "}{p.label}
        </Text>,
      );
    }
    return (
      <FullScreenFrame theme={theme} columns={cols} rows={termRows} title="Add Connection" contentRows={lines.length}>
        {lines}
      </FullScreenFrame>
    );
  }

  if (screen === "add-key") {
    const lines: React.ReactNode[] = [];
    lines.push(<Text key="prompt" color={fg}>API Key:</Text>);
    lines.push(<Text key="input" color={accent}>{keyInput || " "}</Text>);
    lines.push(<Text key="sep"> </Text>);
    lines.push(<Text key="hint" color={dim}>Paste your {addProvider} API key, then press Enter</Text>);
    return (
      <FullScreenFrame theme={theme} columns={cols} rows={termRows} title={`Add ${addProvider} Connection`} contentRows={lines.length}>
        {lines}
      </FullScreenFrame>
    );
  }

  if (screen === "add-label") {
    const lines: React.ReactNode[] = [];
    lines.push(<Text key="prompt" color={fg}>Label (optional):</Text>);
    lines.push(<Text key="input" color={accent}>{labelInput || " "}</Text>);
    lines.push(<Text key="sep"> </Text>);
    lines.push(<Text key="hint" color={dim}>A friendly name for this connection. Press Enter to continue.</Text>);
    return (
      <FullScreenFrame theme={theme} columns={cols} rows={termRows} title={`Add ${addProvider} Connection`} contentRows={lines.length}>
        {lines}
      </FullScreenFrame>
    );
  }

  // screen === "add-url"
  const lines: React.ReactNode[] = [];
  lines.push(<Text key="prompt" color={fg}>Base URL:</Text>);
  lines.push(<Text key="input" color={accent}>{baseUrlInput || " "}</Text>);
  lines.push(<Text key="sep"> </Text>);
  lines.push(<Text key="hint" color={dim}>e.g. http://localhost:11434/v1</Text>);
  return (
    <FullScreenFrame theme={theme} columns={cols} rows={termRows} title={`Add ${addProvider} Connection`} contentRows={lines.length}>
      {lines}
    </FullScreenFrame>
  );
}
