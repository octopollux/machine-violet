import "./suppress-warnings.js";
import { loadEnv, getAppVersion } from "./config/first-launch.js";
import { checkTerminal } from "./config/terminal-check.js";

// --version flag: print and exit before any TUI setup
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`Machine Violet ${getAppVersion()}`);
  process.exit(0);
}

// Velopack lifecycle hooks: headless invocations that must exit promptly.
// These run during install/update/uninstall — no TUI, no terminal upgrade.
if (process.argv.some((a) => a.startsWith("--veloapp-"))) {
  const { handleVelopackHook } = await import("./config/velopack-hooks.js");
  handleVelopackHook();
  process.exit(0);
}

// Load API key from config dir, falling back to cwd .env
loadEnv();

// Bail early on terminals that can't run a TUI
checkTerminal();

import React, { useRef } from "react";
import { render } from "ink";
import App from "./app.js";
import type { ShutdownContext } from "./shutdown.js";
import { gracefulShutdown } from "./shutdown.js";
import { installSyncWriteCombiner } from "./tui/hooks/syncWriteCombiner.js";
import { installRawModeGuard } from "./tui/hooks/rawModeGuard.js";
import { disableMouseReporting } from "./tui/hooks/useMouseScroll.js";

// Prevent stdin raw mode from ever being disabled while the TUI is running.
// On Windows, even a momentary drop to cooked mode causes the console to
// process pending Backspace bytes destructively, visually erasing UI text.
const unlockRawMode = installRawModeGuard(process.stdin);

// Combine Ink's separate BSU / content / ESU writes into single atomic
// stdout writes so the terminal never displays intermediate states
// (e.g. a cleared screen before new content during rapid re-renders).
const removeCombiner = installSyncWriteCombiner(process.stdout);

let shuttingDown = false;

// We need a way to pass the shutdown context from the App component
// to the signal handlers. We use a module-level ref that App populates.
const shutdownCtx: ShutdownContext = {};

function ShutdownWrapper() {
  const ref = useRef(shutdownCtx);
  return <App shutdownRef={ref} />;
}

const { unmount } = render(<ShutdownWrapper />, { maxFps: 60 });

async function handleShutdownSignal(exitCode = 0) {
  if (shuttingDown) {
    // Second signal — force exit
    process.exit(1);
  }
  shuttingDown = true;

  try {
    await gracefulShutdown(shutdownCtx);
  } catch {
    // Best-effort
  }

  if (process.stdout.isTTY) {
    disableMouseReporting(process.stdout);
  }
  unlockRawMode();
  removeCombiner();
  unmount();
  process.exit(exitCode);
}

process.on("SIGINT", () => { handleShutdownSignal(); });
process.on("SIGTERM", () => { handleShutdownSignal(); });
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error && reason.stack ? reason.stack : String(reason);
  process.stderr.write(`\nUnhandled rejection: ${msg}\n`);
  handleShutdownSignal(1);
});
