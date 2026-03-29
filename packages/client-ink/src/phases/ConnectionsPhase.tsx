/**
 * ConnectionsPhase — manage AI provider connections and tier assignments.
 *
 * Three sections:
 * 1. Active connections with health status
 * 2. Model tier assignments (large/medium/small)
 * 3. Add new connection
 */
import React, { useState, useEffect, useRef } from "react";
import { useInput, Text, Box } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { ThemedHorizontalBorder, TerminalTooSmall } from "../tui/components/index.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { useTerminalSize } from "../tui/hooks/useTerminalSize.js";
import { useTextInput } from "../tui/hooks/useTextInput.js";
import { themeColor } from "../tui/themes/color-resolve.js";
import type {
  ConnectionInfo, TierAssignmentsResponse, TierAssignmentEntry,
  KnownModelInfo, ConnectionHealthResponse,
} from "../api-client.js";

// ---------------------------------------------------------------------------
// Sub-modes
// ---------------------------------------------------------------------------

type Section = "connections" | "tiers" | "add";
type AddStep = "provider" | "key" | "label" | "baseUrl";

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
  const [section, setSection] = useState<Section>("connections");
  const [connIndex, setConnIndex] = useState(0);
  const [tierIndex, setTierIndex] = useState(0);
  const [tierModelIndex, setTierModelIndex] = useState(0);
  const [tierEditing, setTierEditing] = useState(false);
  const [addStep, setAddStep] = useState<AddStep>("provider");
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

  // Build model options for tier editing
  const allModels: { connectionId: string; modelId: string; label: string }[] = [];
  for (const conn of connections) {
    for (const m of conn.models) {
      allModels.push({
        connectionId: conn.id,
        modelId: m.id,
        label: `${m.displayName} [${conn.label}]`,
      });
    }
  }

  const tiers = ["large", "medium", "small"] as const;

  useInput((input, key) => {
    if (key.escape) {
      if (section === "add" && addStep !== "provider") {
        setAddStep("provider");
        return;
      }
      if (tierEditing) {
        setTierEditing(false);
        return;
      }
      onBack();
      return;
    }

    // Section navigation with Tab
    if (key.tab) {
      const sections: Section[] = ["connections", "tiers", "add"];
      const idx = sections.indexOf(section);
      setSection(sections[(idx + 1) % sections.length]);
      return;
    }

    // --- Connections section ---
    if (section === "connections") {
      if (key.upArrow) setConnIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) setConnIndex((i) => Math.min(connections.length - 1, i + 1));
      if (input === "r" || input === "R") {
        const conn = connections[connIndex];
        if (conn) onCheckHealth(conn.id);
      }
      if (input === "d" || input === "D") {
        const conn = connections[connIndex];
        if (conn && conn.source !== "env") {
          onRemoveConnection(conn.id);
          setConnIndex((i) => Math.max(0, i - 1));
        }
      }
      if (key.return) {
        // Enter on a connection → check health
        const conn = connections[connIndex];
        if (conn) onCheckHealth(conn.id);
      }
    }

    // --- Tiers section ---
    if (section === "tiers") {
      if (!tierEditing) {
        if (key.upArrow) setTierIndex((i) => Math.max(0, i - 1));
        if (key.downArrow) setTierIndex((i) => Math.min(2, i + 1));
        if (key.return && allModels.length > 0) {
          setTierEditing(true);
          setTierModelIndex(0);
        }
      } else {
        if (key.upArrow) setTierModelIndex((i) => Math.max(0, i - 1));
        if (key.downArrow) setTierModelIndex((i) => Math.min(allModels.length - 1, i + 1));
        if (key.return) {
          const model = allModels[tierModelIndex];
          if (model) {
            onSetTier(tiers[tierIndex], { connectionId: model.connectionId, modelId: model.modelId });
          }
          setTierEditing(false);
        }
      }
    }

    // --- Add section ---
    if (section === "add") {
      if (addStep === "provider") {
        if (key.upArrow) setAddProviderIndex((i) => Math.max(0, i - 1));
        if (key.downArrow) setAddProviderIndex((i) => Math.min(PROVIDER_OPTIONS.length - 1, i + 1));
        if (key.return) {
          setAddProvider(PROVIDER_OPTIONS[addProviderIndex].id);
          setAddStep("key");
          setKeyInput("");
          setLabelInput("");
          setBaseUrlInput("");
        }
      } else if (addStep === "key") {
        if (key.return && keyInput.trim()) {
          setAddStep("label");
        } else {
          handleKeyInput(input, key);
        }
      } else if (addStep === "label") {
        if (key.return) {
          const needsBaseUrl = PROVIDER_OPTIONS.find((p) => p.id === addProvider)?.needsBaseUrl;
          if (needsBaseUrl) {
            setAddStep("baseUrl");
          } else {
            onAddConnection(addProvider, keyInput.trim(), labelInput.trim());
            setAddStep("provider");
          }
        } else {
          handleLabelInput(input, key);
        }
      } else if (addStep === "baseUrl") {
        if (key.return && baseUrlInput.trim()) {
          onAddConnection(addProvider, keyInput.trim(), labelInput.trim(), baseUrlInput.trim());
          setAddStep("provider");
        } else {
          handleBaseUrlInput(input, key);
        }
      }
    }
  });

  if (cols < MIN_COLUMNS || termRows < MIN_ROWS) {
    return <TerminalTooSmall columns={cols} rows={termRows} />;
  }

  const fg = themeColor(theme, "fg");
  const dim = themeColor(theme, "dim");
  const accent = themeColor(theme, "accent");
  // const contentWidth = cols - 4;

  // --- Health status icon ---
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
    if (!h) return dim;
    if (h.status === "valid") return "#88cc88";
    if (h.status === "rate_limited") return "#cccc44";
    return "#cc4444";
  };

  // --- Render ---
  return (
    <Box flexDirection="column" width={cols} height={termRows}>
      <ThemedHorizontalBorder theme={theme} width={cols} position="top" title="AI Connections" />
      <Box flexDirection="column" paddingX={2} height={termRows - 2}>

        {/* Section: Connections */}
        <Text color={section === "connections" ? accent : dim} bold={section === "connections"}>
          {section === "connections" ? "\u25B6" : " "} Connections {`(${connections.length})`}
        </Text>
        {section === "connections" && connections.map((conn, i) => (
          <Box key={conn.id}>
            <Text color={i === connIndex ? accent : fg}>
              {i === connIndex ? " \u25B8 " : "   "}
              <Text color={healthColor(conn.id)}>{healthIcon(conn.id)}</Text>
              {" "}{conn.label}
              <Text color={dim}> — {conn.provider}{conn.models.length > 0 ? ` \u00b7 ${conn.models.length} models` : ""}</Text>
            </Text>
          </Box>
        ))}
        {section === "connections" && connections.length === 0 && (
          <Text color={dim}>   No connections configured. Add one below.</Text>
        )}
        {section === "connections" && (
          <Text color={dim}>   R=recheck  D=delete  Tab=next section  Esc=back</Text>
        )}

        <Text> </Text>

        {/* Section: Tier Assignments */}
        <Text color={section === "tiers" ? accent : dim} bold={section === "tiers"}>
          {section === "tiers" ? "\u25B6" : " "} Model Assignments
        </Text>
        {section === "tiers" && tiers.map((tier, i) => {
          const assignment = tierAssignments[tier];
          const model = assignment ? (knownModels[assignment.modelId]?.displayName ?? assignment.modelId) : "(not set)";
          const connLabel = assignment ? connections.find((c) => c.id === assignment.connectionId)?.label ?? "" : "";

          if (tierEditing && i === tierIndex) {
            return (
              <Box key={tier} flexDirection="column">
                <Text color={accent}> \u25B8 {TIER_LABELS[tier]}: <Text color={dim}>select model...</Text></Text>
                {allModels.map((m, mi) => (
                  <Text key={m.modelId + m.connectionId} color={mi === tierModelIndex ? accent : fg}>
                    {"     "}{mi === tierModelIndex ? "\u25B8 " : "  "}{m.label}
                  </Text>
                ))}
              </Box>
            );
          }

          return (
            <Text key={tier} color={i === tierIndex && section === "tiers" ? accent : fg}>
              {i === tierIndex && section === "tiers" ? " \u25B8 " : "   "}
              {TIER_LABELS[tier]}: {model}
              {connLabel ? <Text color={dim}> [{connLabel}]</Text> : null}
            </Text>
          );
        })}

        <Text> </Text>

        {/* Section: Add Connection */}
        <Text color={section === "add" ? accent : dim} bold={section === "add"}>
          {section === "add" ? "\u25B6" : " "} Add Connection
        </Text>
        {section === "add" && addStep === "provider" && PROVIDER_OPTIONS.map((p, i) => (
          <Text key={p.id} color={i === addProviderIndex ? accent : fg}>
            {i === addProviderIndex ? " \u25B8 " : "   "}{p.label}
          </Text>
        ))}
        {section === "add" && addStep === "key" && (
          <Box flexDirection="column" paddingLeft={3}>
            <Text color={fg}>API Key: <Text color={accent}>{keyInput || " "}</Text></Text>
            <Text color={dim}>Paste your {addProvider} API key, then Enter</Text>
          </Box>
        )}
        {section === "add" && addStep === "label" && (
          <Box flexDirection="column" paddingLeft={3}>
            <Text color={fg}>Label (optional): <Text color={accent}>{labelInput || " "}</Text></Text>
            <Text color={dim}>Press Enter to {PROVIDER_OPTIONS.find((p) => p.id === addProvider)?.needsBaseUrl ? "continue" : "add"}</Text>
          </Box>
        )}
        {section === "add" && addStep === "baseUrl" && (
          <Box flexDirection="column" paddingLeft={3}>
            <Text color={fg}>Base URL: <Text color={accent}>{baseUrlInput || " "}</Text></Text>
            <Text color={dim}>e.g. http://localhost:11434/v1 — then Enter to add</Text>
          </Box>
        )}
      </Box>
      <ThemedHorizontalBorder theme={theme} width={cols} position="bottom" />
    </Box>
  );
}
