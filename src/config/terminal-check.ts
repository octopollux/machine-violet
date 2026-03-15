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
 * Call this before any Ink imports. Exits the process on failure.
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

    // Older conhost without VT support.
    // Windows Terminal sets WT_SESSION; ConEmu sets ConEmuPID;
    // mintty/Git Bash sets TERM. If none of these are present and
    // we're on an older Windows build, warn.
    const hasModernTerminal =
      process.env.WT_SESSION ||      // Windows Terminal
      process.env.ConEmuPID ||        // ConEmu / Cmder
      process.env.TERM_PROGRAM ||     // VSCode terminal, etc.
      process.env.TERM ||             // mintty, Git Bash, WSL
      process.env.ALACRITTY_LOG;      // Alacritty

    if (!hasModernTerminal) {
      // Can't detect any modern terminal marker — warn but don't block,
      // the user might be on a capable terminal we don't recognize.
      console.warn("");
      console.warn("  Warning: Could not detect a known modern terminal.");
      console.warn("  If rendering looks broken, try Windows Terminal: https://aka.ms/terminal");
      console.warn("");
    }
  }
}
