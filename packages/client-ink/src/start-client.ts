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
import { initialClientState, type ClientState } from "./event-handler.js";

// --- Agent sidecar state bridge ---
// Module-level ref updated synchronously by App's handleStateUpdate.
// The sidecar reads it on HTTP request — zero overhead when unused.
let _clientState: ClientState = initialClientState();
export function _setClientState(s: ClientState): void { _clientState = s; }
export function _getClientState(): ClientState { return _clientState; }

export interface StartClientOptions {
  /** Engine server URL (default: http://127.0.0.1:7200). */
  server?: string;
  /** Player name (default: "Player"). */
  player?: string;
  /** Campaign ID to auto-start (shows menu if omitted). */
  campaign?: string;
  /** Port for the dev-only agent sidecar HTTP server. */
  agentPort?: number;
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

  // Agent sidecar: dynamic import keeps @xterm/headless out of the bundle.
  let sidecarClose: (() => Promise<void>) | undefined;
  const agentPort = opts.agentPort;
  if (agentPort) {
    import("./agent-sidecar.js")
      .then(({ startAgentSidecar }) => startAgentSidecar(agentPort, _getClientState))
      .then((h) => { sidecarClose = h.close; })
      .catch((err) => { process.stderr.write(`Agent sidecar failed: ${err}\n`); });
  }

  // Graceful shutdown on SIGINT
  const onSigInt = () => {
    unmount();
  };
  process.on("SIGINT", onSigInt);

  // Wrap waitUntilExit to clean up guards
  const waitUntilExit = async () => {
    await inkWaitUntilExit();
    process.removeListener("SIGINT", onSigInt);
    if (sidecarClose) await sidecarClose();
    unlockRawMode();
    removeCombiner();
  };

  return { unmount, waitUntilExit };
}
