/**
 * Reusable client startup function.
 *
 * Extracted from index.tsx so the launcher can start the client
 * programmatically (single-process mode) while index.tsx continues
 * to work as a standalone CLI entry point.
 */
import React from "react";
import { Readable } from "node:stream";
import { render, type RenderOptions } from "ink";
import { App } from "./app.js";
import { installRawModeGuard } from "./tui/hooks/rawModeGuard.js";
import { installSyncWriteCombiner } from "./tui/hooks/syncWriteCombiner.js";
import {
  detectKittySupport,
  enableKittyProtocol,
  disableKittyProtocol,
  createKittyFilter,
  kittyKeyToLegacy,
} from "./tui/hooks/kittyProtocol.js";
import { installStdinFilterChain } from "./tui/hooks/stdinFilterChain.js";
import { compositePainters } from "./tui/image/painterRegistry.js";
import { detectGraphicsCapabilities } from "./tui/image/capabilities.js";
import { logInputEvent, bytesToHex, getInputDebugLogPath } from "./tui/hooks/inputDebugLog.js";
import { getAgentClientState } from "./agent-state-ref.js";

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
 * Installs the raw mode guard and sync write combiner, probes for Kitty
 * keyboard protocol support, renders the App component, and returns a
 * handle for lifecycle control.
 */
export async function startClient(opts: StartClientOptions = {}): Promise<ClientHandle> {
  const serverUrl = opts.server ?? "http://127.0.0.1:7200";
  const playerId = opts.player ?? "Player";
  const campaignId = opts.campaign;
  const agentPort = opts.agentPort;

  // Headless mode: when --agent-port is set but there's no TTY (e.g. agent
  // spawned the process in the background), create a mock TTY stdin so Ink
  // can enable raw mode without a real terminal.
  let mockStdin: NodeJS.ReadStream | undefined;
  if (agentPort && !process.stdin.isTTY) {
    // Set stdout dimensions if missing (non-TTY) so Ink and the vterm agree.
    if (!process.stdout.columns) process.stdout.columns = 120;
    if (!process.stdout.rows) process.stdout.rows = 40;

    // eslint-disable-next-line @typescript-eslint/no-empty-function -- Readable requires read(); data arrives via push()
    const stream = new Readable({ read() {} }) as NodeJS.ReadStream;
    stream.isTTY = true;
    stream.isRaw = false;
    stream.setRawMode = function (mode: boolean) {
      stream.isRaw = mode;
      return stream;
    };
    // Ink calls ref()/unref() to manage the event loop — no-ops for a mock.
    stream.ref = () => stream;
    stream.unref = () => stream;
    // Don't call resume() here: Ink attaches a 'readable' listener (paused
    // mode) and pulls via stdin.read(). Calling resume() would put the
    // stream in flowing mode, push()'d bytes would fire 'data' instead of
    // 'readable', and Ink would never read the data via its read() loop.
    mockStdin = stream;
  }
  const activeStdin = mockStdin ?? process.stdin;

  // Prevent stdin raw mode from ever being disabled while the TUI is running.
  // On Windows, even a momentary drop to cooked mode (during component unmount/
  // remount cycles) causes the console to stop forwarding keystrokes.
  const unlockRawMode = installRawModeGuard(activeStdin);

  // Combine Ink's separate BSU/content/ESU writes into single atomic stdout
  // writes so the terminal never displays intermediate states. The pre-ESU
  // injector re-blits inline-image graphics (sixel/iTerm2) inside the same
  // atomic frame Ink just drew — see tui/image/painterRegistry.ts.
  const removeCombiner = installSyncWriteCombiner(process.stdout, compositePainters);

  // Install the stdin filter chain — a single read() wrapper that runs
  // all registered filters (kitty, mouse) in order.
  const filterChain = installStdinFilterChain(activeStdin);

  // Probe for Kitty keyboard protocol support. When available, CSI-u
  // encoding makes every keystroke unambiguous — Backspace can never be
  // confused or dropped, even when ConPTY corrupts console mode flags.
  const hasKitty = !mockStdin && activeStdin.isTTY
    ? await detectKittySupport({ stdin: activeStdin, stdout: process.stdout })
    : false;
  logInputEvent("start-client", {
    hasKitty,
    isTTY: !!activeStdin.isTTY,
    mockStdin: !!mockStdin,
    logPath: getInputDebugLogPath(),
  });
  if (hasKitty) {
    enableKittyProtocol(process.stdout);
    filterChain.add(createKittyFilter((key) => {
      // Re-emit as legacy bytes so Ink's useInput picks them up.
      const legacy = kittyKeyToLegacy(key);
      logInputEvent("kitty-legacy-push", {
        key: key.key,
        legacy: legacy === null ? null : bytesToHex(legacy),
        legacyLen: legacy?.length ?? 0,
      });
      if (legacy !== null) activeStdin.push(legacy);
    }));
  }

  // Probe terminal graphics-protocol support (kitty/iTerm2/sixel) + cell-pixel
  // size for the inline-image renderer. Sequenced AFTER the kitty-keyboard
  // probe so the two don't race on stdin, and before render() so Ink isn't yet
  // consuming stdin. Non-TTY / agent mode resolves to no graphics.
  const graphicsCaps = !mockStdin && activeStdin.isTTY
    ? await detectGraphicsCapabilities(activeStdin, process.stdout)
    : { kitty: false, iterm2: false, sixel: false, cellPixels: null, sixelColorRegisters: null };
  logInputEvent("graphics-caps", {
    kitty: graphicsCaps.kitty,
    iterm2: graphicsCaps.iterm2,
    sixel: graphicsCaps.sixel,
    cellPixels: graphicsCaps.cellPixels,
    sixelColorRegisters: graphicsCaps.sixelColorRegisters,
  });

  // alternateScreen: TUI renders in the alt buffer so exit restores whatever
  // the terminal showed before launch instead of leaving the final frame
  // parked above the shell prompt. Only enable for interactive TTY sessions
  // so alt-screen escape codes don't leak into redirected output, pipes, or
  // CI logs.
  const alternateScreen = !mockStdin && Boolean(process.stdout.isTTY) && Boolean(activeStdin.isTTY);
  const renderOpts: RenderOptions = { exitOnCtrlC: !mockStdin, alternateScreen };
  if (mockStdin) {
    renderOpts.stdin = mockStdin;
    // Force Ink interactive mode in headless agent mode. Without this, Ink's
    // resolveInteractiveOption() falls back to `Boolean(stdout.isTTY)` — and
    // since the spawning process has no real TTY, stdout.isTTY is false, so
    // Ink silently skips every non-<Static> stdout.write (ink/build/ink.js
    // around line 329). The agent-sidecar tee then sees nothing. We need
    // real ANSI cursor/erase sequences in the stream so the vterm can render
    // a faithful screen for /screen consumers.
    renderOpts.interactive = true;
  }

  // Agent sidecar: dynamic import keeps @xterm/headless out of the bundle.
  // Must boot BEFORE render() so the vterm tee captures Ink's first frame —
  // Ink only re-renders on state changes, so a missed first frame leaves the
  // virtual screen blank until something forces a redraw.
  let sidecarClose: (() => Promise<void>) | undefined;
  if (agentPort) {
    try {
      const { startAgentSidecar } = await import("./agent-sidecar.js");
      const handle = await startAgentSidecar(agentPort, getAgentClientState, mockStdin);
      sidecarClose = handle.close;
    } catch (err) {
      process.stderr.write(`Agent sidecar failed: ${err}\n`);
    }
  }

  const { unmount, waitUntilExit: inkWaitUntilExit } = render(
    React.createElement(App, { serverUrl, playerId, campaignId, hasKittyProtocol: hasKitty, stdinFilterChain: filterChain, graphicsCaps }),
    renderOpts,
  );

  // Graceful shutdown on SIGINT
  const onSigInt = () => {
    unmount();
  };
  process.on("SIGINT", onSigInt);

  // Wrap waitUntilExit to clean up guards. try/finally ensures terminal
  // mode is always restored even if inkWaitUntilExit or sidecar throws.
  const waitUntilExit = async () => {
    try {
      await inkWaitUntilExit();
      process.removeListener("SIGINT", onSigInt);
      if (sidecarClose) await sidecarClose();
    } finally {
      if (hasKitty) disableKittyProtocol(process.stdout);
      filterChain.teardown();
      unlockRawMode();
      removeCombiner();
    }
  };

  return { unmount, waitUntilExit };
}
