/**
 * Open a file path using the OS default application.
 * Fire-and-forget — errors are silently ignored.
 *
 * Uses spawn with argument arrays (no shell) to avoid command injection.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";

export function openPath(filePath: string): void {
  const opts = { detached: true, stdio: "ignore" as const };
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", "start", '""', filePath], opts)
      : process.platform === "darwin"
        ? spawn("open", [filePath], opts)
        : spawn("xdg-open", [filePath], opts);

  child.on("error", () => { /* ignore errors */ });
  child.unref();
}

/**
 * Reveal a file in the OS file explorer (file selected, parent folder open).
 * Fire-and-forget — errors are silently ignored.
 *
 * Linux has no portable reveal-and-select, so we open the parent directory.
 */
export function revealInExplorer(filePath: string): void {
  const opts = { detached: true, stdio: "ignore" as const };
  let child;
  if (process.platform === "win32") {
    // explorer.exe /select, requires Windows-style backslashes — forward
    // slashes silently fail and Explorer opens the Documents folder instead.
    // Comma (not space) separates the switch from the path.
    const winPath = filePath.replace(/\//g, "\\");
    child = spawn("explorer.exe", [`/select,${winPath}`], opts);
  } else if (process.platform === "darwin") {
    child = spawn("open", ["-R", filePath], opts);
  } else {
    child = spawn("xdg-open", [dirname(filePath)], opts);
  }

  child.on("error", () => { /* ignore errors */ });
  child.unref();
}
