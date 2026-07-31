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
import { useInput, Box } from "ink";
import type { ResolvedTheme } from "../../tui/themes/types.js";
import { FullScreenFrame, hintBar, menuPalette } from "../../tui/components/index.js";
import { CenteredModal } from "../../tui/modals/CenteredModal.js";
import { openPath } from "../../commands/open-path.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import type { ChatGptLoginStartResponse, ChatGptLoginStatusResponse } from "../../api-client.js";
import type { FormattingNode } from "@machine-violet/shared";

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

  // Modal-style body: styled lines rendered by CenteredModal, which wraps
  // long rows (the OAuth URL) to the modal's inner width and pads every row
  // opaque. Hints live in the modal footer, keeping the Esc-until-success
  // grammar.
  const colored = (text: string, color: string): FormattingNode[] =>
    [{ type: "color" as const, color, content: [text] }];

  const styled: FormattingNode[][] = [];
  let footer = ` ${hintBar("Esc cancel")} `;

  if (loginError) {
    styled.push(colored(`Error: ${loginError}`, "#cc4444"));
    footer = ` ${hintBar("Esc back")} `;
  } else if (!loginInfo) {
    styled.push(colored("Starting the sign-in flow…", pal.fg));
  } else if (status === "pending" || status === "success") {
    // Success unmounts via onSuccess in the same tick; render the pending
    // layout until the parent swaps screens so there is no flash.
    styled.push(colored("Sign in by opening this URL in your browser:", pal.fg));
    styled.push([]);
    styled.push(colored(loginInfo.authUrl, "#88ccff"));
    styled.push([]);
    styled.push(colored("Waiting for browser authentication…", pal.dim));
    if (copyStatus === "copied") styled.push(colored("URL copied to clipboard.", "#88cc88"));
    else if (copyStatus === "failed") styled.push(colored("Clipboard unavailable.", "#cc4444"));
    footer = ` ${hintBar("o open in browser", "c copy URL", "Esc cancel")} `;
  } else if (status === "cancelled") {
    styled.push(colored("Sign-in cancelled.", pal.dim));
    footer = ` ${hintBar("Esc back")} `;
  } else {
    styled.push(colored(`Sign-in failed: ${loginStatus?.error ?? "unknown error"}`, "#cc4444"));
    footer = ` ${hintBar("Esc back")} `;
  }

  // Pad to ~60% of terminal height with empty lines so the modal body is
  // fully opaque over the backdrop frame (CenteredModal pads each line to
  // innerWidth, so empty rows render as blank opaque rows).
  const targetRows = Math.max(styled.length, Math.floor(rows * 0.6) - 4);
  while (styled.length < targetRows) {
    styled.push([]);
  }

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <FullScreenFrame theme={theme} columns={columns} rows={rows} title="Connect to AI" contentRows={0}>
        {[]}
      </FullScreenFrame>
      <CenteredModal
        theme={theme}
        width={columns}
        height={rows}
        title="Sign in with ChatGPT"
        widthFraction={0.6}
        minWidth={50}
        maxWidth={Math.max(50, Math.floor(columns * 0.6))}
        styledLines={styled}
        footer={footer}
      />
    </Box>
  );
}
