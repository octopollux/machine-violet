/**
 * Advanced model assignments, scoped to the in-use connection.
 *
 * Tiers are described by role, not size, and the provider default shows as a
 * first-class "Auto (<model>)" value so it's clear nothing here needs
 * touching. Pickers list only models on the in-use connection — assignments
 * never mix providers (the provider is selected on the connection list; a
 * future provider-independent `narration` class is exempt by design).
 */
import React, { useState, useRef } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../../tui/themes/types.js";
import { FullScreenFrame, getScrollWindow, hintBar, menuPalette } from "../../tui/components/index.js";
import type {
  ConnectionInfo, TierAssignmentsResponse, TierAssignmentEntry,
  KnownImageModelInfo, KnownModelInfo, ProviderTierDefaults,
} from "../../api-client.js";
import type { SetTiersBody } from "./ConnectionsArea.js";
import { providerName } from "./providers.js";

const TIERS = ["large", "medium", "small"] as const;
type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  large: "DM narration",
  medium: "Helpers & AI players",
  small: "Quick tasks",
};

const IMAGE_ROW = TIERS.length;
const ROW_COUNT = TIERS.length + 1;

interface PickOption {
  /** null = provider default (image row only). */
  modelId: string | null;
  label: string;
}

export interface ModelAssignmentsProps {
  theme: ResolvedTheme;
  columns: number;
  rows: number;
  connections: ConnectionInfo[];
  tierAssignments: TierAssignmentsResponse;
  imageAssignment: TierAssignmentEntry | null;
  knownModels: Record<string, KnownModelInfo>;
  knownImageModels: Record<string, KnownImageModelInfo>;
  tierDefaults: Record<string, ProviderTierDefaults>;
  onSetTiers: (body: SetTiersBody) => Promise<void>;
  onBack: () => void;
}

export function ModelAssignments({
  theme, columns, rows,
  connections, tierAssignments, imageAssignment,
  knownModels, knownImageModels, tierDefaults,
  onSetTiers, onBack,
}: ModelAssignmentsProps) {
  const [rowIndex, setRowIndex] = useState(0);
  const [picking, setPicking] = useState<Tier | "image" | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  const pickScrollRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The in-use connection scopes everything on this screen.
  const activeConn = tierAssignments.large
    ? connections.find((c) => c.id === tierAssignments.large?.connectionId)
    : connections[0];
  const defaults: ProviderTierDefaults = activeConn ? (tierDefaults[activeConn.provider] ?? {}) : {};

  const modelName = (id: string) => knownModels[id]?.displayName ?? id;

  /** Value text for a tier row: `Auto (X)`, `X (override)`, or `(not set)`. */
  const tierValue = (tier: Tier): string => {
    const a = tierAssignments[tier];
    if (!a) return "(not set)";
    const name = modelName(a.modelId);
    return a.modelId === defaults[tier] ? `Auto (${name})` : `${name} (override)`;
  };

  const pickOptions = (target: Tier | "image"): PickOption[] => {
    if (!activeConn) return [];
    if (target === "image") {
      const options: PickOption[] = [{ modelId: null, label: "Auto — provider default (recommended)" }];
      for (const [modelId, info] of Object.entries(knownImageModels)) {
        if (info.provider === activeConn.provider) {
          options.push({ modelId, label: info.displayName });
        }
      }
      return options;
    }
    const options: PickOption[] = [];
    const def = defaults[target];
    if (def && activeConn.models.some((m) => m.id === def)) {
      options.push({ modelId: def, label: `Auto — ${modelName(def)} (recommended)` });
    }
    for (const m of activeConn.models) {
      if (m.id === def) continue;
      options.push({ modelId: m.id, label: m.displayName });
    }
    return options;
  };

  const applyPick = (target: Tier | "image", option: PickOption) => {
    if (!activeConn) return;
    if (target !== "image" && option.modelId === null) return; // null is image-only
    setSaving(true);
    setError(null);
    const body: SetTiersBody = target === "image"
      ? { imageAssignment: option.modelId ? { connectionId: activeConn.id, modelId: option.modelId } : null }
      : { [target]: { connectionId: activeConn.id, modelId: option.modelId } };
    void onSetTiers(body)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => { setSaving(false); setPicking(null); });
  };

  useInput((_input, key) => {
    if (saving) return;
    if (picking) {
      const options = pickOptions(picking);
      if (key.escape) { setPicking(null); return; }
      if (key.upArrow) { setPickIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setPickIndex((i) => Math.min(options.length - 1, i + 1)); return; }
      if (key.return && options[pickIndex]) applyPick(picking, options[pickIndex]);
      return;
    }
    if (key.escape) { onBack(); return; }
    if (key.upArrow) { setRowIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setRowIndex((i) => Math.min(ROW_COUNT - 1, i + 1)); return; }
    if (key.return && activeConn) {
      const target: Tier | "image" = rowIndex === IMAGE_ROW ? "image" : TIERS[rowIndex];
      const options = pickOptions(target);
      if (options.length === 0) return;
      // Preselect the current value.
      const current = target === "image"
        ? options.findIndex((o) => o.modelId === (imageAssignment?.modelId ?? null))
        : options.findIndex((o) => o.modelId === tierAssignments[target]?.modelId);
      setPickIndex(Math.max(0, current));
      pickScrollRef.current = 0;
      setPicking(target);
    }
  });

  const pal = menuPalette(theme);

  // --- Picker screen ---
  if (picking && activeConn) {
    const options = pickOptions(picking);
    const title = picking === "image" ? "Scene Images" : TIER_LABELS[picking];
    const lines: React.ReactNode[] = [];
    lines.push(
      <Text key="header" color={pal.dim}>
        {picking === "image"
          ? `Image model for ${activeConn.label}:`
          : `Model for ${TIER_LABELS[picking].toLowerCase()} on ${activeConn.label}:`}
      </Text>,
    );
    lines.push(<Text key="sep"> </Text>);
    const visibleRows = rows - theme.asset.height * 2 - lines.length - 2;
    const win = getScrollWindow(pickIndex, options.length, visibleRows, pickScrollRef.current);
    pickScrollRef.current = win.start;
    for (let i = win.start; i < win.end; i++) {
      const o = options[i];
      const selected = i === pickIndex;
      const visibleIndex = i - win.start;
      const arrow = visibleIndex === 0 ? "▲" : visibleIndex === 1 ? "▼" : " ";
      const arrowAvailable = visibleIndex === 0 ? win.canScrollUp : win.canScrollDown;
      lines.push(
        <Text key={o.modelId ?? "provider-default"} color={selected ? pal.accent : pal.fg}>
          {visibleIndex < 2
            ? arrowAvailable
              ? <Text color="#aaff00">{arrow}</Text>
              : <Text dimColor>{arrow}</Text>
            : arrow}
          {" "}{selected ? "◆ " : "  "}{o.label}
        </Text>,
      );
    }
    lines.push(<Text key="hint-gap"> </Text>);
    lines.push(
      <Text key="hints" color={pal.dim}>{hintBar("↑↓ select", "Enter apply", "Esc back")}</Text>,
    );
    return (
      <FullScreenFrame theme={theme} columns={columns} rows={rows} title={title} contentRows={lines.length}>
        {lines}
      </FullScreenFrame>
    );
  }

  // --- Assignment rows ---
  const lines: React.ReactNode[] = [];
  if (!activeConn) {
    lines.push(<Text key="none" color={pal.dim}>Add a connection first.</Text>);
  } else {
    lines.push(
      <Text key="scope" color={pal.dim}>
        Models from {activeConn.label} ({providerName(activeConn.provider)}). Auto follows the provider default.
      </Text>,
    );
    lines.push(<Text key="scope-gap"> </Text>);
    for (let i = 0; i < TIERS.length; i++) {
      const tier = TIERS[i];
      const selected = i === rowIndex;
      lines.push(
        <Text key={tier} color={selected ? pal.accent : pal.fg} bold={selected}>
          {selected ? "◆ " : "  "}{TIER_LABELS[tier]}
        </Text>,
      );
      lines.push(
        <Text key={`${tier}-val`} color={selected ? pal.fg : pal.dim}>
          {"    "}{tierValue(tier)}
        </Text>,
      );
    }
    const imageSelected = rowIndex === IMAGE_ROW;
    const imageName = imageAssignment
      ? (knownImageModels[imageAssignment.modelId]?.displayName ?? imageAssignment.modelId)
      : "Auto (provider default)";
    lines.push(
      <Text key="image" color={imageSelected ? pal.accent : pal.fg} bold={imageSelected}>
        {imageSelected ? "◆ " : "  "}Scene images
      </Text>,
    );
    lines.push(
      <Text key="image-val" color={imageSelected ? pal.fg : pal.dim}>
        {"    "}{imageName}
      </Text>,
    );
  }

  if (error) {
    lines.push(<Text key="err-gap"> </Text>);
    lines.push(<Text key="err" color="#cc4444">{error.replace(/\s+/g, " ").trim()}</Text>);
  }
  lines.push(<Text key="hint-gap"> </Text>);
  lines.push(
    <Text key="hints" color={pal.dim}>
      {saving ? "Saving…" : hintBar("↑↓ select", "Enter change", "Esc back")}
    </Text>,
  );

  return (
    <FullScreenFrame theme={theme} columns={columns} rows={rows} title="Model Assignments" contentRows={lines.length}>
      {lines}
    </FullScreenFrame>
  );
}
