/**
 * Detect known-unsupported terminals and exit with a helpful message
 * before Ink tries to initialize (which produces an ugly stack trace).
 */

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
 * Check that the current terminal can run Ink.
 * Call this before TUI initialization (render, raw mode setup).
 * Exits the process on failure.
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
    // ISE sets PSHost name to "Windows PowerShell ISE Host"
    // and doesn't set WT_SESSION
    if (process.env.PSISE !== undefined || process.env.__PSISE !== undefined) {
      die(
        "PowerShell ISE does not support ANSI escape sequences or raw mode.",
        "Use Windows Terminal instead: https://aka.ms/terminal",
      );
    }

    // Note: we don't warn on "unknown" terminals. Windows conhost has
    // supported VT sequences since Win 10 1511, and when Windows Terminal
    // is the default console host (Win 11), it doesn't set WT_SESSION for
    // processes launched via Explorer. Only block on known-broken terminals.
  }
}
