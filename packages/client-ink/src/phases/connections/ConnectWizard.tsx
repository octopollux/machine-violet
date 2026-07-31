/**
 * Connect to AI wizard: one linear flow from provider choice to a verified,
 * ready-to-play connection.
 *
 *   provider → key (→ url for custom) → validate → result
 *   provider → ChatGPT OAuth → result
 *
 * The auth method is folded into the provider choice (signing in with a
 * ChatGPT subscription is just another row, and the recommended one). The key
 * is validated before the wizard declares success: an invalid key bounces
 * back to the key screen with the provider's actual error and the input still
 * populated; only a verified connection reaches the result screen. There is
 * no label step — connections are auto-named server-side from the provider's
 * display name.
 */
import React, { useState, useEffect } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../../tui/themes/types.js";
import { FullScreenFrame, buildMenuLines, hintBar, menuPalette } from "../../tui/components/index.js";
import type { MenuRow } from "../../tui/components/index.js";
import { useTextInput } from "../../tui/hooks/useTextInput.js";
import { openPath } from "../../commands/open-path.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import type {
  ConnectionInfo, TierAssignmentsResponse, KnownModelInfo,
  ConnectionHealthResponse, ChatGptLoginStartResponse, ChatGptLoginStatusResponse,
} from "../../api-client.js";
import { VISIBLE_PROVIDER_OPTIONS, type ProviderOption } from "./providers.js";

type Step =
  | { kind: "provider" }
  | { kind: "key"; provider: ProviderOption }
  | { kind: "url"; provider: ProviderOption }
  | { kind: "busy"; message: string }
  | { kind: "chatgpt" }
  | {
      kind: "result";
      headline: string;
      headlineColor: string;
      connectionId?: string;
      note?: string;
    };

export interface ConnectWizardProps {
  theme: ResolvedTheme;
  columns: number;
  rows: number;
  connections: ConnectionInfo[];
  tierAssignments: TierAssignmentsResponse;
  knownModels: Record<string, KnownModelInfo>;
  onAddConnection: (provider: string, apiKey: string, baseUrl?: string) => Promise<ConnectionInfo>;
  onRemoveConnection: (id: string) => Promise<void>;
  onCheckHealth: (id: string) => Promise<ConnectionHealthResponse>;
  /** Make a connection the game's provider (tiers → provider defaults). */
  onApplyConnection: (conn: ConnectionInfo) => Promise<void>;
  onStartChatGptLogin: () => Promise<ChatGptLoginStartResponse>;
  onPollChatGptLogin: (loginId: string) => Promise<ChatGptLoginStatusResponse>;
  onCancelChatGptLogin: (loginId: string) => Promise<unknown>;
  onRefreshConnections: () => void;
  /** Wizard finished (verified connection or explicit keep) — land on the list. */
  onDone: () => void;
  /** Player backed out of the wizard root. */
  onExit: () => void;
}

/** Mask all but the last four characters of a secret while typing. */
export function maskSecret(value: string): string {
  if (value.length === 0) return "";
  if (value.length <= 4) return "•".repeat(value.length);
  const masked = "•".repeat(value.length - 4) + value.slice(-4);
  // Keep very long keys on one line — show a truncation marker + tail.
  return masked.length > 44 ? `…${masked.slice(-43)}` : masked;
}

export function ConnectWizard({
  theme, columns, rows,
  connections, tierAssignments, knownModels,
  onAddConnection, onRemoveConnection, onCheckHealth, onApplyConnection,
  onStartChatGptLogin, onPollChatGptLogin, onCancelChatGptLogin, onRefreshConnections,
  onDone, onExit,
}: ConnectWizardProps) {
  const [step, setStep] = useState<Step>({ kind: "provider" });
  const [providerIndex, setProviderIndex] = useState(0);
  const [keyInput, setKeyInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const { handleKey: handleKeyInput } = useTextInput({ value: keyInput, onChange: setKeyInput });
  const { handleKey: handleUrlInput } = useTextInput({ value: urlInput, onChange: setUrlInput });

  // ChatGPT OAuth state
  const [loginInfo, setLoginInfo] = useState<{ loginId: string; authUrl: string } | null>(null);
  const [loginStatus, setLoginStatus] = useState<ChatGptLoginStatusResponse | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const pal = menuPalette(theme);

  const activeId = tierAssignments.large?.connectionId ?? null;
  const activeConn = activeId ? connections.find((c) => c.id === activeId) : undefined;

  // Poll the OAuth login while on the chatgpt step.
  useEffect(() => {
    if (step.kind !== "chatgpt" || !loginInfo) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await onPollChatGptLogin(loginInfo.loginId);
        if (cancelled) return;
        setLoginStatus(status);
        if (status.status === "success") {
          onRefreshConnections();
          const suffix = `${status.email ? ` as ${status.email}` : ""}${status.planType ? ` (${status.planType})` : ""}`;
          setStep({
            kind: "result",
            headline: `✔ Signed in${suffix}`,
            headlineColor: "#88cc88",
            connectionId: status.connectionId,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setLoginError(err instanceof Error ? err.message : String(err));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [step.kind, loginInfo, onPollChatGptLogin, onRefreshConnections]);

  const startChatGptLogin = () => {
    setLoginInfo(null);
    setLoginStatus(null);
    setLoginError(null);
    setCopyStatus("idle");
    setStep({ kind: "chatgpt" });
    void (async () => {
      try {
        const start = await onStartChatGptLogin();
        setLoginInfo({ loginId: start.loginId, authUrl: start.authUrl });
      } catch (err) {
        setLoginError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  /** Add + verify a key-based connection; bounce back to the key screen on a bad key. */
  const submitKeyConnection = (provider: ProviderOption) => {
    const apiKey = keyInput.trim();
    const baseUrl = provider.needsBaseUrl ? urlInput.trim() : undefined;
    setStep({ kind: "busy", message: "Checking your key…" });
    void (async () => {
      let conn: ConnectionInfo;
      try {
        conn = await onAddConnection(provider.id, apiKey, baseUrl);
      } catch (err) {
        setInputError(err instanceof Error ? err.message : String(err));
        setStep({ kind: "key", provider });
        return;
      }
      let health: ConnectionHealthResponse;
      try {
        health = await onCheckHealth(conn.id);
      } catch (err) {
        // Couldn't verify (network, server) — keep the connection, but say so.
        setStep({
          kind: "result",
          headline: `Added ${conn.label} — couldn't verify the key yet`,
          headlineColor: "#cccc44",
          connectionId: conn.id,
          note: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (health.status === "valid" || health.status === "rate_limited") {
        setStep({
          kind: "result",
          headline: `✔ Connected to ${conn.label}`,
          headlineColor: "#88cc88",
          connectionId: conn.id,
          note: health.status === "rate_limited" ? "The key works (currently rate limited)." : undefined,
        });
      } else if (health.status === "invalid") {
        // Bad key: remove the connection we just added and let the player
        // fix the input rather than stranding a broken entry in the list.
        await onRemoveConnection(conn.id).catch(() => { /* best-effort */ });
        setInputError(health.message);
        setStep({ kind: "key", provider });
      } else {
        setStep({
          kind: "result",
          headline: `Added ${conn.label} — couldn't verify the key yet`,
          headlineColor: "#cccc44",
          connectionId: conn.id,
          note: health.message,
        });
      }
    })();
  };

  useInput((input, key) => {
    if (step.kind === "busy") return;

    if (step.kind === "provider") {
      if (key.escape) { onExit(); return; }
      if (key.upArrow) { setProviderIndex((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setProviderIndex((i) => Math.min(VISIBLE_PROVIDER_OPTIONS.length - 1, i + 1)); return; }
      if (key.return) {
        const provider = VISIBLE_PROVIDER_OPTIONS[providerIndex];
        setInputError(null);
        if (provider.auth === "oauth") {
          startChatGptLogin();
        } else {
          setKeyInput("");
          setUrlInput("");
          setStep({ kind: "key", provider });
        }
      }
      return;
    }

    if (step.kind === "key") {
      if (key.escape) { setInputError(null); setStep({ kind: "provider" }); return; }
      if (key.return) {
        if (!keyInput.trim()) {
          setInputError(`Paste your ${step.provider.name} API key first.`);
          return;
        }
        setInputError(null);
        if (step.provider.needsBaseUrl) setStep({ kind: "url", provider: step.provider });
        else submitKeyConnection(step.provider);
        return;
      }
      if (handleKeyInput(input, key)) setInputError(null);
      return;
    }

    if (step.kind === "url") {
      if (key.escape) { setInputError(null); setStep({ kind: "key", provider: step.provider }); return; }
      if (key.return) {
        if (!urlInput.trim()) {
          setInputError("Enter the endpoint's base URL first.");
          return;
        }
        setInputError(null);
        submitKeyConnection(step.provider);
        return;
      }
      if (handleUrlInput(input, key)) setInputError(null);
      return;
    }

    if (step.kind === "chatgpt") {
      if (key.escape) {
        if (loginInfo && (loginStatus?.status ?? "pending") === "pending") {
          void onCancelChatGptLogin(loginInfo.loginId).catch(() => { /* best-effort */ });
        }
        setStep({ kind: "provider" });
        return;
      }
      if (key.return && loginStatus && loginStatus.status !== "pending" && loginStatus.status !== "success") {
        setStep({ kind: "provider" });
        return;
      }
      if (loginInfo && (loginStatus?.status ?? "pending") === "pending") {
        if (input === "o" || input === "O") { openPath(loginInfo.authUrl); return; }
        if (input === "c" || input === "C") {
          void copyToClipboard(loginInfo.authUrl).then((ok) => setCopyStatus(ok ? "copied" : "failed"));
          return;
        }
      }
      return;
    }

    // step.kind === "result"
    const resultConn = step.connectionId
      ? connections.find((c) => c.id === step.connectionId)
      : undefined;
    const needsSwitch = !!resultConn && !!activeId && resultConn.id !== activeId;
    if (key.return) {
      if (needsSwitch && resultConn) {
        setStep({ kind: "busy", message: `Switching to ${resultConn.label}…` });
        void onApplyConnection(resultConn)
          .then(() => onDone())
          .catch((err) => {
            setStep({
              kind: "result",
              headline: `Couldn't switch to ${resultConn.label}`,
              headlineColor: "#cc4444",
              connectionId: resultConn.id,
              note: err instanceof Error ? err.message : String(err),
            });
          });
      } else {
        onDone();
      }
      return;
    }
    if (needsSwitch && (input === "k" || input === "K")) { onDone(); return; }
    if (key.escape) { onDone(); return; }
  });

  // --- Render ---

  const frame = (lines: React.ReactNode[]) => (
    <FullScreenFrame theme={theme} columns={columns} rows={rows} title="Connect to AI" contentRows={lines.length}>
      {lines}
    </FullScreenFrame>
  );

  if (step.kind === "provider") {
    const rows_: MenuRow[] = VISIBLE_PROVIDER_OPTIONS.map((p) => ({
      key: p.id,
      label: p.name,
      description: p.desc,
      suffix: p.badge ? ` · ${p.badge}` : undefined,
      suffixColor: p.badge === "recommended" ? "#88cc88" : "#cccc44",
    }));
    const lines: React.ReactNode[] = [];
    lines.push(<Text key="q" color={pal.fg}>How will Machine Violet connect to AI?</Text>);
    lines.push(<Text key="q-gap"> </Text>);
    lines.push(...buildMenuLines(rows_, providerIndex, pal));
    lines.push(<Text key="hint-gap"> </Text>);
    lines.push(
      <Text key="hints" color={pal.dim}>{hintBar("↑↓ select", "Enter choose", "Esc back")}</Text>,
    );
    return frame(lines);
  }

  if (step.kind === "key" || step.kind === "url") {
    const provider = step.provider;
    const isKey = step.kind === "key";
    const lines: React.ReactNode[] = [];
    lines.push(
      <Text key="prompt" color={pal.fg}>
        {isKey ? `Paste your ${provider.name} API key:` : "Base URL of your endpoint:"}
      </Text>,
    );
    lines.push(
      <Text key="input" color={pal.accent}>
        {isKey ? (maskSecret(keyInput) || " ") : (urlInput || " ")}
      </Text>,
    );
    lines.push(<Text key="sep"> </Text>);
    if (isKey && provider.keySource) {
      lines.push(<Text key="source" color={pal.dim}>Find or create one at {provider.keySource}</Text>);
    }
    if (!isKey) {
      lines.push(<Text key="example" color={pal.dim}>e.g. http://localhost:11434/v1</Text>);
    }
    if (inputError) {
      lines.push(<Text key="err" color="#cc4444">{inputError.replace(/\s+/g, " ").trim()}</Text>);
    }
    lines.push(<Text key="hint-gap"> </Text>);
    lines.push(
      <Text key="hints" color={pal.dim}>{hintBar("Enter continue", "Esc back")}</Text>,
    );
    return frame(lines);
  }

  if (step.kind === "busy") {
    return frame([<Text key="busy" color={pal.fg}>{step.message}</Text>]);
  }

  if (step.kind === "chatgpt") {
    const status = loginStatus?.status ?? "pending";
    const lines: React.ReactNode[] = [];
    if (loginError) {
      lines.push(<Text key="err" color="#cc4444">Error: {loginError}</Text>);
      lines.push(<Text key="err-gap"> </Text>);
      lines.push(<Text key="err-hint" color={pal.dim}>{hintBar("Esc back")}</Text>);
    } else if (!loginInfo) {
      lines.push(<Text key="starting" color={pal.fg}>Starting the sign-in flow…</Text>);
      lines.push(<Text key="s-gap"> </Text>);
      lines.push(<Text key="s-hint" color={pal.dim}>{hintBar("Esc cancel")}</Text>);
    } else if (status === "pending") {
      lines.push(<Text key="open" color={pal.fg}>Sign in by opening this URL in your browser:</Text>);
      lines.push(<Text key="o-gap"> </Text>);
      lines.push(<Text key="url" color="#88ccff">{loginInfo.authUrl}</Text>);
      lines.push(<Text key="u-gap"> </Text>);
      lines.push(<Text key="waiting" color={pal.dim}>Waiting for browser authentication…</Text>);
      if (copyStatus === "copied") lines.push(<Text key="copied" color="#88cc88">URL copied to clipboard.</Text>);
      else if (copyStatus === "failed") lines.push(<Text key="copyfail" color="#cc4444">Clipboard unavailable.</Text>);
      lines.push(<Text key="hint-gap"> </Text>);
      lines.push(
        <Text key="hints" color={pal.dim}>{hintBar("o open in browser", "c copy URL", "Esc cancel")}</Text>,
      );
    } else if (status === "cancelled") {
      lines.push(<Text key="cancelled" color={pal.dim}>Sign-in cancelled.</Text>);
      lines.push(<Text key="c-hint" color={pal.dim}>{hintBar("Esc back")}</Text>);
    } else {
      lines.push(<Text key="failed" color="#cc4444">Sign-in failed: {loginStatus?.error ?? "unknown error"}</Text>);
      lines.push(<Text key="f-hint" color={pal.dim}>{hintBar("Esc back")}</Text>);
    }
    return frame(lines);
  }

  // step.kind === "result"
  const resultConn = step.connectionId
    ? connections.find((c) => c.id === step.connectionId)
    : undefined;
  const needsSwitch = !!resultConn && !!activeId && resultConn.id !== activeId;
  const lines: React.ReactNode[] = [];
  lines.push(<Text key="headline" color={step.headlineColor} bold>{step.headline}</Text>);
  if (step.note) {
    lines.push(<Text key="note" color={pal.dim}>{step.note.replace(/\s+/g, " ").trim()}</Text>);
  }
  lines.push(<Text key="h-gap"> </Text>);
  if (needsSwitch && resultConn && activeConn) {
    lines.push(
      <Text key="current" color={pal.fg}>
        Your game is currently set up to use {activeConn.label}.
      </Text>,
    );
    lines.push(<Text key="s-gap"> </Text>);
    lines.push(
      <Text key="hints" color={pal.dim}>
        {hintBar(`Enter switch to ${resultConn.label}`, `K keep ${activeConn.label}`)}
      </Text>,
    );
  } else {
    if (resultConn && resultConn.id === activeId) {
      const dmModelId = tierAssignments.large?.modelId;
      const dmModel = dmModelId ? (knownModels[dmModelId]?.displayName ?? dmModelId) : undefined;
      if (dmModel) {
        lines.push(
          <Text key="dm" color={pal.fg}>
            The DM will run on {dmModel} — change anytime under Model assignments.
          </Text>,
        );
        lines.push(<Text key="dm-gap"> </Text>);
      }
    }
    lines.push(<Text key="hints" color={pal.dim}>{hintBar("Enter continue")}</Text>);
  }
  return frame(lines);
}
