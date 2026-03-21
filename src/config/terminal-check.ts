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
 * The conhost GUID used in the DelegationConsole registry value.
 * When this is set, the user has explicitly chosen Windows Console Host.
 */
const CONHOST_CLSID = "{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}";

/**
 * Check whether a non-conhost terminal has registered as the default
 * console host via the Windows DefaultTerminal / "delegation" mechanism.
 *
 * Registry: HKCU\Console\%%Startup\DelegationConsole
 *   - Key missing          → no delegation support (Win10) → bare conhost
 *   - CONHOST_CLSID        → user explicitly chose conhost
 *   - {000...0}            → "Let Windows decide" (Win11 default — uses WT)
 *   - Any other GUID       → a terminal registered as delegate (WT, Alacritty, etc.)
 */
function hasTerminalDelegation(): boolean {
  try {
    const result = execFileSync(
      "reg",
      ["query", "HKCU\\Console\\%%Startup", "/v", "DelegationConsole"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
    );
    const match = result.match(/DelegationConsole\s+REG_SZ\s+(\S+)/);
    if (!match) return false;
    const clsid = match[1].toUpperCase();
    // Explicit conhost selection — no delegation
    if (clsid === CONHOST_CLSID.toUpperCase()) return false;
    // Any other value (including {000...0} "Let Windows decide") means
    // a modern terminal is handling console hosting.
    return true;
  } catch {
    // Key doesn't exist (Win10 without delegation support) or reg.exe failed
    return false;
  }
}

/**
 * Detect if we're running in a terminal that should be upgraded to
 * Windows Terminal. Returns false for known-good terminals that handle
 * emoji and formatting well; true for bare conhost (cmd.exe, Explorer
 * double-click, PowerShell 5 in legacy console).
 *
 * Two-tier detection:
 * 1. Environment variables — catches terminals launched explicitly
 *    (WT tabs, Git Bash, Alacritty, ConEmu, etc.)
 * 2. Registry delegation — catches WT-as-default-terminal and other
 *    registered delegates where env vars aren't set.
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

  // No env var detected — check if a modern terminal is registered as
  // the default console host. This covers WT-as-default-terminal on
  // Win11 (and any other registered delegate) where the process is
  // launched by a shortcut/stub and env vars aren't propagated.
  if (hasTerminalDelegation()) return false;

  // Bare conhost with no delegation — upgrade.
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
