/**
 * The list-first "Connect to AI" screen. Connections render with a health
 * glyph, provider name, and usage; the last rows add a connection or open the
 * advanced model-assignment screen. Enter opens per-connection detail.
 */
import React, { useState } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../../tui/themes/types.js";
import { FullScreenFrame, hintBar, menuPalette } from "../../tui/components/index.js";
import type { ConnectionInfo, ConnectionHealthResponse, UsageResponse } from "../../api-client.js";
import { providerName } from "./providers.js";
import { formatSegment, segmentStatusColor } from "./usage-format.js";

export const HEALTH_COLORS = {
  valid: "#88cc88",
  rate_limited: "#cccc44",
  invalid: "#cc4444",
  error: "#cc4444",
  unknown: "#666666",
} as const;

export function healthIcon(h: ConnectionHealthResponse | undefined): string {
  if (!h) return "?";
  if (h.status === "valid") return "✔";
  if (h.status === "rate_limited") return "⚠";
  if (h.status === "invalid") return "✘";
  return "•";
}

export function healthColor(h: ConnectionHealthResponse | undefined): string {
  if (!h) return HEALTH_COLORS.unknown;
  if (h.status === "valid") return HEALTH_COLORS.valid;
  if (h.status === "rate_limited") return HEALTH_COLORS.rate_limited;
  return HEALTH_COLORS.invalid;
}

export interface ConnectionsListProps {
  theme: ResolvedTheme;
  columns: number;
  rows: number;
  connections: ConnectionInfo[];
  healthResults: Record<string, ConnectionHealthResponse>;
  usageByConn: Record<string, UsageResponse>;
  /** Connection currently assigned to the Large tier (the one the game uses). */
  activeConnectionId: string | null;
  onOpenDetail: (conn: ConnectionInfo) => void;
  onAdd: () => void;
  onModels: () => void;
  onBack: () => void;
}

export function ConnectionsList({
  theme, columns, rows,
  connections, healthResults, usageByConn, activeConnectionId,
  onOpenDetail, onAdd, onModels, onBack,
}: ConnectionsListProps) {
  // Row model: one entry per connection, then "Add", then (if any connection
  // exists) "Model assignments".
  const showModels = connections.length > 0;
  const rowCount = connections.length + 1 + (showModels ? 1 : 0);
  const [index, setIndex] = useState(0);

  const addIndex = connections.length;
  const modelsIndex = connections.length + 1;

  useInput((_input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.upArrow) { setIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setIndex((i) => Math.min(rowCount - 1, i + 1)); return; }
    if (key.return) {
      if (index < connections.length) onOpenDetail(connections[index]);
      else if (index === addIndex) onAdd();
      else if (showModels && index === modelsIndex) onModels();
    }
  });

  const pal = menuPalette(theme);
  const lines: React.ReactNode[] = [];

  for (let i = 0; i < connections.length; i++) {
    const conn = connections[i];
    const selected = i === index;
    const h = healthResults[conn.id];
    const inUse = conn.id === activeConnectionId;
    lines.push(
      <Text key={conn.id}>
        <Text color={selected ? pal.accent : pal.dim}>{selected ? "◆ " : "○ "}</Text>
        <Text color={healthColor(h)}>{healthIcon(h)}</Text>
        <Text color={selected ? pal.accent : pal.fg} bold={selected}>{` ${conn.label}`}</Text>
        <Text color={pal.dim}>{` — ${providerName(conn.provider)}`}</Text>
        {inUse ? <Text color={HEALTH_COLORS.valid}>{" · in use"}</Text> : null}
      </Text>,
    );
    const usage = usageByConn[conn.id];
    if (usage?.available && usage.status) {
      for (const seg of usage.status.segments) {
        lines.push(
          <Text key={`${conn.id}-${seg.id}`}>
            <Text>{"     "}</Text>
            <Text color={segmentStatusColor(seg.status)}>{formatSegment(seg)}</Text>
          </Text>,
        );
      }
    }
  }

  if (connections.length === 0) {
    lines.push(
      <Text key="empty" color={pal.dim}>No AI connection yet — add one to play.</Text>,
    );
    lines.push(<Text key="empty-gap"> </Text>);
  }

  const addSelected = index === addIndex;
  lines.push(
    <Text key="add">
      <Text color={addSelected ? pal.accent : pal.dim}>{addSelected ? "◆ " : "○ "}</Text>
      <Text color={addSelected ? pal.accent : pal.fg} bold={addSelected}>＋ Add connection</Text>
    </Text>,
  );
  if (showModels) {
    const modelsSelected = index === modelsIndex;
    lines.push(
      <Text key="models">
        <Text color={modelsSelected ? pal.accent : pal.dim}>{modelsSelected ? "◆ " : "○ "}</Text>
        <Text color={modelsSelected ? pal.accent : pal.fg} bold={modelsSelected}>Model assignments</Text>
        <Text color={pal.dim}>{" — advanced"}</Text>
      </Text>,
    );
  }

  lines.push(<Text key="hint-gap"> </Text>);
  lines.push(
    <Text key="hints" color={pal.dim}>
      {hintBar("↑↓ select", "Enter open", "Esc back")}
    </Text>,
  );

  return (
    <FullScreenFrame theme={theme} columns={columns} rows={rows} title="Connect to AI" contentRows={lines.length}>
      {lines}
    </FullScreenFrame>
  );
}
