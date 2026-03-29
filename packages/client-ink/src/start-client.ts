/**
 * Reusable client startup function.
 *
 * Extracted from index.tsx so the launcher can start the client
 * programmatically (single-process mode) while index.tsx continues
 * to work as a standalone CLI entry point.
 */
import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { installRawModeGuard } from "./tui/hooks/rawModeGuard.js";
import { installSyncWriteCombiner } from "./tui/hooks/syncWriteCombiner.js";

export interface StartClientOptions {
  /** Engine server URL (default: http://127.0.0.1:7200). */
  server?: string;
  /** Player name (default: "Player"). */
  player?: string;
  /** Campaign ID to auto-start (shows menu if omitted). */
  campaign?: string;
}

export interface ClientHandle {
  /** Unmount the Ink application. */
  unmount: () => void;
  /** Resolves when the Ink application exits. */
  waitUntilExit: () => Promise<void>;
}

/**
 * Start the Ink TUI client.
 *
 * Installs the raw mode guard and sync write combiner, renders the
 * App component, and returns a handle for lifecycle control.
 */
export function startClient(opts: StartClientOptions = {}): ClientHandle {
  const serverUrl = opts.server ?? "http://127.0.0.1:7200";
  const playerId = opts.player ?? "Player";
  const campaignId = opts.campaign;

  // Prevent stdin raw mode from ever being disabled while the TUI is running.
  // On Windows, even a momentary drop to cooked mode (during component unmount/
  // remount cycles) causes the console to stop forwarding keystrokes.
  const unlockRawMode = installRawModeGuard(process.stdin);

  // Combine Ink's separate BSU/content/ESU writes into single atomic stdout
  // writes so the terminal never displays intermediate states.
  const removeCombiner = installSyncWriteCombiner(process.stdout);

  const { unmount, waitUntilExit: inkWaitUntilExit } = render(
    React.createElement(App, { serverUrl, playerId, campaignId }),
    { exitOnCtrlC: true },
  );

  // Graceful shutdown on SIGINT
  process.on("SIGINT", () => {
    unmount();
  });

  // Wrap waitUntilExit to clean up guards
  const waitUntilExit = async () => {
    await inkWaitUntilExit();
    unlockRawMode();
    removeCombiner();
  };

  return { unmount, waitUntilExit };
}
