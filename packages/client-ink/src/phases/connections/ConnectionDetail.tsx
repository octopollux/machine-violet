/**
 * Per-connection detail: status, key, usage, plus the actions that used to
 * hide behind single-letter hotkeys (recheck, delete) and the new "use this
 * connection" selection. Deleting asks for a second Enter; env-provided
 * connections explain why they can't be deleted instead of silently refusing.
 */
import React, { useState } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../../tui/themes/types.js";
import { FullScreenFrame, buildMenuLines, hintBar, menuPalette } from "../../tui/components/index.js";
import type { MenuRow } from "../../tui/components/index.js";
import type {
  ConnectionInfo, ConnectionHealthResponse, UsageResponse,
  KnownModelInfo, TierAssignmentsResponse,
} from "../../api-client.js";
import { providerName } from "./providers.js";
import { formatSegment, segmentStatusColor } from "./usage-format.js";
import { healthColor, healthIcon } from "./ConnectionsList.js";

export interface ConnectionDetailProps {
  theme: ResolvedTheme;
  columns: number;
  rows: number;
  connection: ConnectionInfo;
  health: ConnectionHealthResponse | undefined;
  usage: UsageResponse | undefined;
  /** Whether this connection is the one the game uses (Large tier). */
  isActive: boolean;
  knownModels: Record<string, KnownModelInfo>;
  tierAssignments: TierAssignmentsResponse;
  onApply: () => Promise<void>;
  onCheck: () => Promise<ConnectionHealthResponse>;
  /** Open the Fix flow (re-enter key, or re-sign-in for ChatGPT). */
  onFix: () => void;
  onRemove: () => Promise<void>;
  onBack: () => void;
}

type Busy = null | "applying" | "checking" | "deleting";

export function ConnectionDetail({
  theme, columns, rows,
  connection: conn, health, usage, isActive, knownModels, tierAssignments,
  onApply, onCheck, onFix, onRemove, onBack,
}: ConnectionDetailProps) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEnv = conn.source === "env";
  const pal = menuPalette(theme);

  // A failed check gets a first-class remedy, not just a red glyph.
  const broken = health?.status === "invalid" || health?.status === "error";

  const actions: MenuRow[] = [];
  if (broken) {
    actions.push(
      isEnv
        ? {
            key: "fix", label: "Fix connection", disabled: true,
            description: "update the environment variable, then check again",
          }
        : {
            key: "fix", label: "Fix connection", emphasis: true,
            description: conn.provider === "openai-chatgpt" ? "sign in again" : "re-enter your API key",
          },
    );
  }
  actions.push(
    isActive
      ? { key: "use", label: "Use this connection", description: "already in use", disabled: true }
      : { key: "use", label: "Use this connection", description: `play with ${providerName(conn.provider)}'s models` },
  );
  actions.push({ key: "check", label: "Check connection" });
  actions.push(
    isEnv
      ? {
          key: "delete", label: "Delete connection", disabled: true,
          description: "set by an environment variable — remove it from your environment instead",
        }
      : confirmDelete
        ? { key: "delete", label: "Delete connection", description: "press Enter again to confirm", emphasis: true }
        : { key: "delete", label: "Delete connection" },
  );

  // The actions list can shrink under the caret — e.g. a re-check flips
  // broken → healthy and the leading "Fix connection" row disappears. Clamp
  // at use so a stale index can never dereference past the end.
  const selectedIndex = Math.min(index, actions.length - 1);

  useInput((_input, key) => {
    if (busy) return;
    if (key.escape) {
      if (confirmDelete) { setConfirmDelete(false); return; }
      onBack();
      return;
    }
    if (key.upArrow) { setIndex(Math.max(0, selectedIndex - 1)); setConfirmDelete(false); return; }
    if (key.downArrow) { setIndex(Math.min(actions.length - 1, selectedIndex + 1)); setConfirmDelete(false); return; }
    if (!key.return) return;

    const action = actions[selectedIndex];
    if (!action || action.disabled) return;
    setError(null);
    if (action.key === "fix") {
      onFix();
    } else if (action.key === "use") {
      setBusy("applying");
      void onApply()
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(null));
    } else if (action.key === "check") {
      setBusy("checking");
      void onCheck()
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(null));
    } else if (action.key === "delete") {
      if (!confirmDelete) { setConfirmDelete(true); return; }
      setBusy("deleting");
      void onRemove()
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
          setBusy(null);
          setConfirmDelete(false);
        });
      // On success onRemove pops the screen — no local state to restore.
    }
  });

  const lines: React.ReactNode[] = [];

  lines.push(
    <Text key="provider">
      <Text color={pal.dim}>{"Provider   "}</Text>
      <Text color={pal.fg}>{providerName(conn.provider)}</Text>
    </Text>,
  );
  const statusText = busy === "checking" ? "Checking…" : health ? health.message : "Not checked yet";
  lines.push(
    <Text key="status">
      <Text color={pal.dim}>{"Status     "}</Text>
      <Text color={busy === "checking" ? pal.dim : healthColor(health)}>
        {busy === "checking" ? statusText : `${healthIcon(health)} ${statusText}`}
      </Text>
    </Text>,
  );
  if (conn.provider !== "openai-chatgpt" && conn.masked) {
    lines.push(
      <Text key="key">
        <Text color={pal.dim}>{"Key        "}</Text>
        <Text color={pal.fg}>{conn.masked}</Text>
      </Text>,
    );
  }
  if (conn.baseUrl) {
    lines.push(
      <Text key="url">
        <Text color={pal.dim}>{"Endpoint   "}</Text>
        <Text color={pal.fg}>{conn.baseUrl}</Text>
      </Text>,
    );
  }
  if (isActive) {
    const dmModelId = tierAssignments.large?.modelId;
    const dmModel = dmModelId ? (knownModels[dmModelId]?.displayName ?? dmModelId) : undefined;
    lines.push(
      <Text key="dm">
        <Text color={pal.dim}>{"In use     "}</Text>
        <Text color={pal.fg}>{dmModel ? `DM runs on ${dmModel}` : "yes"}</Text>
      </Text>,
    );
  }
  lines.push(
    <Text key="models">
      <Text color={pal.dim}>{"Models     "}</Text>
      <Text color={pal.fg}>{conn.models.length > 0 ? `${conn.models.length} available` : "none discovered"}</Text>
    </Text>,
  );
  if (usage?.available && usage.status) {
    for (const seg of usage.status.segments) {
      lines.push(
        <Text key={`usage-${seg.id}`}>
          <Text color={pal.dim}>{"Usage      "}</Text>
          <Text color={segmentStatusColor(seg.status)}>{formatSegment(seg)}</Text>
        </Text>,
      );
    }
  }

  lines.push(<Text key="gap"> </Text>);
  lines.push(...buildMenuLines(actions, selectedIndex, pal));

  if (error) {
    lines.push(<Text key="err-gap"> </Text>);
    lines.push(<Text key="err" color="#cc4444">{error.replace(/\s+/g, " ").trim()}</Text>);
  }
  if (busy === "applying" || busy === "deleting") {
    lines.push(<Text key="busy-gap"> </Text>);
    lines.push(
      <Text key="busy" color={pal.dim}>
        {busy === "applying" ? "Applying…" : "Deleting…"}
      </Text>,
    );
  }

  lines.push(<Text key="hint-gap"> </Text>);
  lines.push(
    <Text key="hints" color={pal.dim}>
      {hintBar("↑↓ select", "Enter confirm", "Esc back")}
    </Text>,
  );

  return (
    <FullScreenFrame theme={theme} columns={columns} rows={rows} title={conn.label} contentRows={lines.length}>
      {lines}
    </FullScreenFrame>
  );
}
