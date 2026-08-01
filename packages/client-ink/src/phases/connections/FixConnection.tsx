/**
 * Fix a failed key-based connection by re-entering its API key in place.
 * The connection id (and therefore tier assignments) is preserved — this is
 * PATCH /manage/connections/:id, not delete + re-add. Same validate-on-submit
 * contract as the connect wizard: an invalid key stays here with the
 * provider's actual error; only a passing health check leaves the screen.
 */
import React, { useState } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../../tui/themes/types.js";
import { FullScreenFrame, hintBar, menuPalette } from "../../tui/components/index.js";
import { useTextInput } from "../../tui/hooks/useTextInput.js";
import type { ConnectionInfo, ConnectionHealthResponse } from "../../api-client.js";
import { PROVIDER_OPTIONS, providerName } from "./providers.js";
import { maskSecret } from "./ConnectWizard.js";

export interface FixConnectionProps {
  theme: ResolvedTheme;
  columns: number;
  rows: number;
  connection: ConnectionInfo;
  /** Replace the connection's key in place; rejects with the server's message. */
  onUpdateKey: (apiKey: string) => Promise<void>;
  onCheck: () => Promise<ConnectionHealthResponse>;
  /** Key verified (or verification unavailable) — back to detail. */
  onDone: () => void;
  onBack: () => void;
}

export function FixConnection({
  theme, columns, rows,
  connection: conn, onUpdateKey, onCheck, onDone, onBack,
}: FixConnectionProps) {
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { handleKey: handleKeyInput } = useTextInput({ value: keyInput, onChange: setKeyInput });

  const name = providerName(conn.provider);
  const keySource = PROVIDER_OPTIONS.find((p) => p.id === conn.provider)?.keySource;

  useInput((input, key) => {
    if (busy) return;
    if (key.escape) { onBack(); return; }
    if (key.return) {
      const apiKey = keyInput.trim();
      if (!apiKey) {
        setError(`Paste your ${name} API key first.`);
        return;
      }
      setError(null);
      setBusy(true);
      void (async () => {
        try {
          await onUpdateKey(apiKey);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setBusy(false);
          return;
        }
        let health: ConnectionHealthResponse;
        try {
          health = await onCheck();
        } catch {
          // Key saved but unverifiable right now — the detail screen shows
          // the health state; don't trap the player here.
          onDone();
          return;
        }
        if (health.status === "invalid") {
          setError(health.message);
          setBusy(false);
          return;
        }
        onDone();
      })();
      return;
    }
    if (handleKeyInput(input, key)) setError(null);
  });

  const pal = menuPalette(theme);
  const lines: React.ReactNode[] = [];
  lines.push(<Text key="prompt" color={pal.fg}>Paste a new {name} API key:</Text>);
  lines.push(<Text key="input" color={pal.accent}>{maskSecret(keyInput) || " "}</Text>);
  lines.push(<Text key="sep"> </Text>);
  if (keySource) {
    lines.push(<Text key="source" color={pal.dim}>Find or create one at {keySource}</Text>);
  }
  lines.push(
    <Text key="keeps" color={pal.dim}>
      Replaces the key on {conn.label} — model choices are kept.
    </Text>,
  );
  if (error) {
    lines.push(<Text key="err" color="#cc4444">{error.replace(/\s+/g, " ").trim()}</Text>);
  }
  lines.push(<Text key="hint-gap"> </Text>);
  lines.push(
    <Text key="hints" color={pal.dim}>
      {busy ? "Checking your key…" : hintBar("Enter continue", "Esc back")}
    </Text>,
  );

  return (
    <FullScreenFrame theme={theme} columns={columns} rows={rows} title={`Fix ${conn.label}`} contentRows={lines.length}>
      {lines}
    </FullScreenFrame>
  );
}
