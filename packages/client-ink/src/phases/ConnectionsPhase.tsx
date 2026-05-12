/**
 * ConnectionsPhase — manage AI provider connections and tier assignments.
 *
 * Multi-screen navigation:
 *   Main menu → Connections list (health, delete)
 *            → Model Assignments (tier → model picker)
 *            → Add Connection (provider → key → label → baseUrl wizard)
 */
import React, { useState, useEffect, useRef } from "react";
import { useInput, Box, Text, useWindowSize } from "ink";
import type { ResolvedTheme } from "../tui/themes/types.js";
import { TerminalTooSmall, FullScreenFrame } from "../tui/components/index.js";
import { CenteredModal } from "../tui/modals/CenteredModal.js";
import { MIN_COLUMNS, MIN_ROWS } from "../tui/responsive.js";
import { useTextInput } from "../tui/hooks/useTextInput.js";
import { themeColor } from "../tui/themes/color-resolve.js";
import { openPath } from "../commands/open-path.js";
import { copyToClipboard } from "../utils/clipboard.js";
import type {
  ConnectionInfo, TierAssignmentsResponse, TierAssignmentEntry,
  KnownModelInfo, ConnectionHealthResponse,
  ChatGptLoginStartResponse, ChatGptLoginStatusResponse, UsageResponse,
} from "../api-client.js";
import type { UsageSegment } from "@machine-violet/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type Screen =
  | "menu"
  | "connections"
  | "tiers"
  | "tier-pick"
  | "add-provider"
  | "add-key"
  | "add-label"
  | "add-url"
  | "chatgpt-login";

const MENU_ITEMS = ["Connections", "Model Assignments", "Add Connection", "Sign in with ChatGPT"] as const;

/**
 * Provider options for the Add-Connection wizard.
 *
 * Note `openai-chatgpt` is intentionally absent here — it goes through a
 * dedicated "Sign in with ChatGPT" entry in the Connections menu (no API
 * key paste; OAuth via the codex app-server).
 */
const PROVIDER_OPTIONS = [
  { id: "anthropic", label: "Anthropic", needsBaseUrl: false },
  { id: "openai-apikey", label: "OpenAI (API key)", needsBaseUrl: false },
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
// Usage segment rendering
// ---------------------------------------------------------------------------

function formatSegment(seg: UsageSegment): string {
  const reset = seg.resetsAt ? `, resets ${formatRelativeTime(seg.resetsAt)}` : "";
  switch (seg.kind) {
    case "percentage":
      return `${seg.label}: ${formatPercent(seg.usedPercent)}${reset}`;
    case "balance":
      return `${seg.label}: ${formatBalance(seg.used, seg.total, seg.unit)}${reset}`;
    case "tokens":
      return `${seg.label}: ${formatBalance(seg.used, seg.total, seg.unit ?? "tokens")}${reset}`;
  }
}

function formatPercent(p: number | undefined): string {
  if (p === undefined) return "—";
  return `${p.toFixed(p < 10 ? 1 : 0)}% used`;
}

function formatBalance(used: number | undefined, total: number | undefined, unit?: string): string {
  if (used === undefined || total === undefined) return "—";
  const u = unit ?? "";
  const usedStr = unit === "USD" ? `$${used.toFixed(2)}` : `${used.toLocaleString()}${u ? " " + u : ""}`;
  const totalStr = unit === "USD" ? `$${total.toFixed(2)}` : `${total.toLocaleString()}`;
  return `${usedStr} / ${totalStr}`;
}

function formatRelativeTime(epochSec: number): string {
  const deltaSec = epochSec - Math.floor(Date.now() / 1000);
  if (deltaSec <= 0) return "now";
  if (deltaSec < 60) return `in ${deltaSec}s`;
  if (deltaSec < 3600) return `in ${Math.round(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `in ${Math.round(deltaSec / 3600)}h`;
  return `in ${Math.round(deltaSec / 86400)}d`;
}

function segmentStatusColor(status: UsageSegment["status"]): string {
  switch (status) {
    case "ok": return "#88cc88";
    case "warning": return "#cccc44";
    case "critical": return "#cc8844";
    case "exceeded": return "#cc4444";
  }
}

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
  // ChatGPT-account OAuth login. The phase manages the polling loop
  // internally — `onStart` kicks it off and `onPoll` is called every ~2s
  // until the returned status is success/error/cancelled. `onRefresh`
  // triggers a reload of the connections list after successful login.
  onStartChatGptLogin?: () => Promise<ChatGptLoginStartResponse>;
  onPollChatGptLogin?: (loginId: string) => Promise<ChatGptLoginStatusResponse>;
  onCancelChatGptLogin?: (loginId: string) => Promise<unknown>;
  onRefreshConnections?: () => void;
  // Usage status fetcher — phase polls per-connection on the connections
  // screen. Returns `available: false` when no live snapshot exists
  // (idle session, non-codex provider, etc.), in which case the row
  // simply omits the usage line.
  onFetchUsage?: (connectionId: string) => Promise<UsageResponse>;
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
  onStartChatGptLogin,
  onPollChatGptLogin,
  onCancelChatGptLogin,
  onRefreshConnections,
  onFetchUsage,
}: ConnectionsPhaseProps) {
  const { columns: cols, rows: termRows } = useWindowSize();
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

  // ChatGPT login state
  const [loginInfo, setLoginInfo] = useState<{ loginId: string; authUrl: string } | null>(null);
  const [loginStatus, setLoginStatus] = useState<ChatGptLoginStatusResponse | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  // Per-connection usage cache. Refreshed on connections-screen mount and
  // every 30s after that. Connections without a live snapshot stay null
  // and render no usage line.
  const [usageByConn, setUsageByConn] = useState<Record<string, UsageResponse>>({});
  const usageFetchedRef = useRef(new Set<string>());

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

  // Fetch usage status for each connection on the connections screen.
  // Refreshed every 30s so live windows (Codex 5h primary) stay current
  // without busy-polling. Connections without a live snapshot stay null.
  useEffect(() => {
    if (screen !== "connections" || !onFetchUsage) return;
    let cancelled = false;
    const fetchAll = async () => {
      for (const conn of connections) {
        try {
          const res = await onFetchUsage(conn.id);
          if (cancelled) return;
          setUsageByConn((prev) => ({ ...prev, [conn.id]: res }));
          usageFetchedRef.current.add(conn.id);
        } catch {
          // best-effort — leave the row's usage line absent
        }
      }
    };
    void fetchAll();
    const timer = setInterval(() => void fetchAll(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [screen, connections, onFetchUsage]);

  // ChatGPT login: drive the polling loop while on the chatgpt-login screen.
  useEffect(() => {
    if (screen !== "chatgpt-login" || !loginInfo || !onPollChatGptLogin) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await onPollChatGptLogin(loginInfo.loginId);
        if (cancelled) return;
        setLoginStatus(status);
        if (status.status === "success" || status.status === "error" || status.status === "cancelled") {
          if (status.status === "success") onRefreshConnections?.();
        }
      } catch (err) {
        if (cancelled) return;
        setLoginError(err instanceof Error ? err.message : String(err));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [screen, loginInfo, onPollChatGptLogin, onRefreshConnections]);

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
        else if (menuIndex === 3) {
          // Sign in with ChatGPT — kick off OAuth and switch to the
          // login progress screen. The polling effect above takes over
          // from there.
          if (!onStartChatGptLogin) return;
          setLoginInfo(null);
          setLoginStatus(null);
          setLoginError(null);
          setCopyStatus("idle");
          setScreen("chatgpt-login");
          void (async () => {
            try {
              const start = await onStartChatGptLogin();
              setLoginInfo({ loginId: start.loginId, authUrl: start.authUrl });
            } catch (err) {
              setLoginError(err instanceof Error ? err.message : String(err));
            }
          })();
        }
      }
      return;
    }

    // --- ChatGPT login progress ---
    if (screen === "chatgpt-login") {
      if (key.escape) {
        // Cancel an in-flight login when bailing out.
        if (loginInfo && loginStatus?.status === "pending" && onCancelChatGptLogin) {
          void onCancelChatGptLogin(loginInfo.loginId).catch(() => { /* ignore */ });
        }
        setScreen("menu");
        return;
      }
      if (key.return && loginStatus && loginStatus.status !== "pending") {
        // Acknowledge the terminal status and go back.
        setScreen("menu");
        return;
      }
      // Hotkeys for the URL — only meaningful once we have one.
      if (loginInfo && (loginStatus?.status ?? "pending") === "pending") {
        if (input === "o" || input === "O") {
          openPath(loginInfo.authUrl);
          return;
        }
        if (input === "c" || input === "C") {
          void copyToClipboard(loginInfo.authUrl).then((ok) => {
            setCopyStatus(ok ? "copied" : "failed");
          });
          return;
        }
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
      // Usage segments \u2014 one short line per segment when a live snapshot
      // exists. Segments without one (idle session, providers without a
      // usage concept, polling not yet returned) just render nothing.
      const usage = usageByConn[conn.id];
      if (usage?.available && usage.status) {
        for (const seg of usage.status.segments) {
          lines.push(
            <Text key={`${conn.id}-${seg.id}`} color={dim}>
              {"     "}
              <Text color={segmentStatusColor(seg.status)}>{formatSegment(seg)}</Text>
            </Text>,
          );
        }
      }
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

  if (screen === "chatgpt-login") {
    // Render the AI Connections menu underneath as the visual base; the
    // login flow renders as a centered modal overlay on top.
    const menuLines: React.ReactNode[] = [];
    for (let i = 0; i < MENU_ITEMS.length; i++) {
      const selected = i === menuIndex;
      menuLines.push(
        <Text key={MENU_ITEMS[i]} color={selected ? border : dim}>
          {selected ? "\u25c6" : "\u25cb"}{" "}{MENU_ITEMS[i]}
        </Text>,
      );
    }

    const status = loginStatus?.status ?? "pending";
    const modalChildren: React.ReactNode[] = [];
    let modalFooter = "Esc cancel";

    if (loginError) {
      modalChildren.push(<Text key="err" color="#cc4444">Error: {loginError}</Text>);
      modalChildren.push(<Text key="sp" color={dim}> </Text>);
      modalChildren.push(<Text key="back" color={dim}>Press Enter or Esc to return.</Text>);
    } else if (!loginInfo) {
      modalChildren.push(<Text key="starting" color={fg}>Starting Codex subprocess and OAuth flow\u2026</Text>);
    } else {
      modalChildren.push(<Text key="instr" color={fg}>Sign in by opening this URL in your browser:</Text>);
      modalChildren.push(<Text key="sp" color={dim}> </Text>);
      modalChildren.push(<Text key="url" color="#88ccff">{loginInfo.authUrl}</Text>);
      modalChildren.push(<Text key="sp2" color={dim}> </Text>);
      if (status === "pending") {
        modalChildren.push(<Text key="status" color={dim}>Waiting for browser authentication\u2026</Text>);
        if (copyStatus === "copied") {
          modalChildren.push(<Text key="copy" color="#88cc88">URL copied to clipboard.</Text>);
        } else if (copyStatus === "failed") {
          modalChildren.push(<Text key="copy" color="#cc4444">Clipboard unavailable.</Text>);
        }
        modalFooter = " o open in browser \u00b7 c copy URL \u00b7 Esc cancel ";
      } else if (status === "success") {
        modalChildren.push(<Text key="status" color="#88cc88">
          \u2714 Signed in{loginStatus?.email ? ` as ${loginStatus.email}` : ""}{loginStatus?.planType ? ` (${loginStatus.planType})` : ""}.
        </Text>);
        modalChildren.push(<Text key="sp3" color={dim}> </Text>);
        modalChildren.push(<Text key="dismiss" color={dim}>Press Enter or Esc to return.</Text>);
      } else if (status === "cancelled") {
        modalChildren.push(<Text key="status" color={dim}>Login cancelled.</Text>);
        modalChildren.push(<Text key="dismiss" color={dim}>Press Enter or Esc to return.</Text>);
      } else {
        modalChildren.push(<Text key="status" color="#cc4444">Login failed: {loginStatus?.error ?? "unknown error"}</Text>);
        modalChildren.push(<Text key="dismiss" color={dim}>Press Enter or Esc to return.</Text>);
      }
    }

    // Aim for ~60% of terminal height as visible content rows. CenteredModal
    // wraps that with its own borders and clamps to fit the screen.
    const modalContentRows = Math.max(8, Math.floor(termRows * 0.6) - 4);

    return (
      <Box flexDirection="column" width={cols} height={termRows}>
        <FullScreenFrame theme={theme} columns={cols} rows={termRows} title="AI Connections" contentRows={menuLines.length}>
          {menuLines}
        </FullScreenFrame>
        <CenteredModal
          theme={theme}
          width={cols}
          height={termRows}
          title="Sign in with ChatGPT"
          widthFraction={0.6}
          minWidth={50}
          maxWidth={Math.max(50, Math.floor(cols * 0.6))}
          contentHeight={modalContentRows}
          footer={modalFooter}
        >
          {modalChildren}
        </CenteredModal>
      </Box>
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
