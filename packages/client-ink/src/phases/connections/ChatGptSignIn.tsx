/**
 * ChatGPT OAuth sign-in screen — starts the flow on mount, polls status every
 * 2 s, and hands a verified success back to the caller. Shared by the connect
 * wizard (first sign-in) and the connection detail's Fix flow (re-sign-in;
 * the server upserts the existing connection in place).
 *
 * Hint rule (see docs/tui-design.md): every not-yet-successful state hints
 * Esc as the way out; success itself is reported via `onSuccess`, so this
 * component never renders a success screen of its own.
 */
import React, { useState, useEffect, useRef } from "react";
import { useInput, Text } from "ink";
import type { ResolvedTheme } from "../../tui/themes/types.js";
import { FullScreenFrame, hintBar, menuPalette } from "../../tui/components/index.js";
import { openPath } from "../../commands/open-path.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import type { ChatGptLoginStartResponse, ChatGptLoginStatusResponse } from "../../api-client.js";

export interface ChatGptSignInProps {
  theme: ResolvedTheme;
  columns: number;
  rows: number;
  onStart: () => Promise<ChatGptLoginStartResponse>;
  onPoll: (loginId: string) => Promise<ChatGptLoginStatusResponse>;
  onCancel: (loginId: string) => Promise<unknown>;
  /** Called exactly once when the login reaches verified success. */
  onSuccess: (status: ChatGptLoginStatusResponse) => void;
  /** Player backed out (Esc from any not-yet-successful state). */
  onExit: () => void;
}

export function ChatGptSignIn({
  theme, columns, rows,
  onStart, onPoll, onCancel, onSuccess, onExit,
}: ChatGptSignInProps) {
  const [loginInfo, setLoginInfo] = useState<{ loginId: string; authUrl: string } | null>(null);
  const [loginStatus, setLoginStatus] = useState<ChatGptLoginStatusResponse | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const startedRef = useRef(false);
  const succeededRef = useRef(false);

  // Kick off the OAuth flow once on mount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const start = await onStart();
        setLoginInfo({ loginId: start.loginId, authUrl: start.authUrl });
      } catch (err) {
        setLoginError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [onStart]);

  // Poll while pending.
  useEffect(() => {
    if (!loginInfo) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await onPoll(loginInfo.loginId);
        if (cancelled) return;
        setLoginStatus(status);
        if (status.status === "success" && !succeededRef.current) {
          succeededRef.current = true;
          onSuccess(status);
        }
      } catch (err) {
        if (cancelled) return;
        setLoginError(err instanceof Error ? err.message : String(err));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [loginInfo, onPoll, onSuccess]);

  useInput((input, key) => {
    if (key.escape) {
      if (loginInfo && (loginStatus?.status ?? "pending") === "pending") {
        void onCancel(loginInfo.loginId).catch(() => { /* best-effort */ });
      }
      onExit();
      return;
    }
    if (loginInfo && (loginStatus?.status ?? "pending") === "pending") {
      if (input === "o" || input === "O") { openPath(loginInfo.authUrl); return; }
      if (input === "c" || input === "C") {
        void copyToClipboard(loginInfo.authUrl).then((ok) => setCopyStatus(ok ? "copied" : "failed"));
        return;
      }
    }
  });

  const pal = menuPalette(theme);
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
  } else if (status === "pending" || status === "success") {
    // Success unmounts via onSuccess in the same tick; render the pending
    // layout until the parent swaps screens so there is no flash.
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

  return (
    <FullScreenFrame theme={theme} columns={columns} rows={rows} title="Connect to AI" contentRows={lines.length}>
      {lines}
    </FullScreenFrame>
  );
}
