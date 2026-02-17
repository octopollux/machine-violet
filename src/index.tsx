// Suppress punycode deprecation (DEP0040) from isomorphic-git dependency
const _origEmit = process.emit;
// @ts-expect-error – patching process.emit signature for warning filter
process.emit = function (ev: string | symbol, ...args: unknown[]) {
  if (ev === "warning" && args[0] instanceof Error && args[0].message.includes("punycode")) {
    return false;
  }
  // @ts-expect-error – forwarding to original emit
  return _origEmit.call(this, ev, ...args);
};

import "dotenv/config";
import React, { useRef } from "react";
import { render } from "ink";
import App from "./app.js";
import type { ShutdownContext } from "./shutdown.js";
import { gracefulShutdown } from "./shutdown.js";

let shuttingDown = false;

// We need a way to pass the shutdown context from the App component
// to the signal handlers. We use a module-level ref that App populates.
const shutdownCtx: ShutdownContext = {};

function ShutdownWrapper() {
  const ref = useRef(shutdownCtx);
  return <App shutdownRef={ref} />;
}

const { unmount } = render(<ShutdownWrapper />);

async function handleShutdownSignal() {
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

  unmount();
  process.exit(0);
}

process.on("SIGINT", () => { handleShutdownSignal(); });
process.on("SIGTERM", () => { handleShutdownSignal(); });
