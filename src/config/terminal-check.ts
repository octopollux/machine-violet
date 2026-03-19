/**
 * Terminal detection and upgrade for Windows.
 *
 * On Windows, if we're running in bare conhost (no Windows Terminal),
 * and a WT binary is available (system-installed or bundled portable),
 * re-launch ourselves inside it for proper emoji, italic, and color support.
 *
 * Also detects known-unsupported terminals and exits with a helpful message
 * before Ink tries to initialize (which produces an ugly stack trace).
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompiled } from "../utils/paths.js";

function die(reason: string, suggestion: string): never {
  console.error("");
  console.error(`  Machine Violet cannot run in this terminal.`);
  console.error(`  ${reason}`);
  console.error("");
  console.error(`  ${suggestion}`);
  console.error("");
  process.exit(1);
}

/**
 * Detect if we're running in a terminal that should be upgraded to
 * Windows Terminal. Returns false for known-good terminals that handle
 * emoji and formatting well; true for bare conhost (cmd.exe, Explorer
 * double-click, PowerShell 5 in legacy console).
 *
 * Logic: exclude known-good terminals, then default to upgrading.
 * This covers the Explorer double-click case where conhost is spawned
 * directly with no shell env vars set at all.
 */
function shouldUpgradeTerminal(): boolean {
  // Windows Terminal sets WT_SESSION for all child processes
  if (process.env.WT_SESSION) return false;

  // Git Bash / MSYS2 / Cygwin set MSYSTEM or TERM
  if (process.env.MSYSTEM || process.env.TERM === "xterm" || process.env.TERM === "xterm-256color") return false;

  // Mintty, Alacritty, WezTerm, Hyper, etc. set TERM_PROGRAM
  if (process.env.TERM_PROGRAM) return false;

  // ConEmu / Cmder
  if (process.env.ConEmuPID) return false;

  // No known-good terminal detected — upgrade from conhost.
  // This covers: cmd.exe, Explorer double-click, PowerShell 5 in legacy console.
  return true;
}

/**
 * Find the best available Windows Terminal binary.
 * Returns the path to wt.exe / WindowsTerminal.exe, or null.
 */
function findWindowsTerminal(): string | null {
  // 1. System-installed wt.exe (Store, winget, MSIX)
  try {
    const result = execFileSync("where.exe", ["wt.exe"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const firstLine = result.trim().split(/\r?\n/)[0];
    if (firstLine) return firstLine;
  } catch { /* not found */ }

  // 2. Bundled portable Windows Terminal (next to our exe)
  if (isCompiled()) {
    const bundled = join(dirname(process.execPath), "terminal", "WindowsTerminal.exe");
    if (existsSync(bundled)) return bundled;
  }

  return null;
}

/**
 * Check that the current terminal can run Ink.
 * On Windows, may re-launch the process inside Windows Terminal and exit.
 * Call this before TUI initialization (render, raw mode setup).
 */
export function checkTerminal(): void {
  // stdin must be a TTY for raw mode (Ink requirement)
  if (!process.stdin.isTTY) {
    die(
      "stdin is not a TTY (piped input or non-interactive shell).",
      "Run machine-violet directly in a terminal, not piped or in a script.",
    );
  }

  // stdout should be a TTY for ANSI rendering
  if (!process.stdout.isTTY) {
    die(
      "stdout is not a TTY.",
      "Run machine-violet directly in a terminal, not piped to a file.",
    );
  }

  // Windows-specific checks
  if (process.platform === "win32") {
    // PowerShell ISE: no VT sequence support, no raw mode
    if (process.env.PSISE !== undefined || process.env.__PSISE !== undefined) {
      die(
        "PowerShell ISE does not support ANSI escape sequences or raw mode.",
        "Use Windows Terminal instead: https://aka.ms/terminal",
      );
    }

    // Skip --no-wt to allow users to opt out of the upgrade
    if (process.argv.includes("--no-wt")) return;

    // Only upgrade from bare conhost. Don't force users out of
    // PowerShell 7, Git Bash, or other modern terminals that handle
    // emoji and formatting fine.
    if (!shouldUpgradeTerminal()) return;

    // Running in bare conhost — try to upgrade to Windows Terminal.
    const wt = findWindowsTerminal();
    if (wt) {
      // Re-launch ourselves inside Windows Terminal and exit this process.
      // The spawned WT process opens its own window; we detach so the
      // original conhost can close.
      try {
        const args = ["--title", "Machine Violet", "--", process.execPath, ...process.argv.slice(1)];
        const child = spawn(wt, args, { detached: true, stdio: "ignore" });
        child.unref();
        process.exit(0);
      } catch {
        // Spawn failed (permissions, missing DLL, etc.) — fall through
        // and continue in the current conhost.
      }
    }

    // No Windows Terminal available (or spawn failed) — continue in conhost.
  }
}
