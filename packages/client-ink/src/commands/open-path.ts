/**
 * Open a file path using the OS default application.
 * Fire-and-forget — errors are silently ignored.
 */
import { exec } from "node:child_process";

export function openPath(filePath: string): void {
  const escaped = filePath.replace(/"/g, '\\"');
  const cmd =
    process.platform === "win32" ? `start "" "${escaped}"` :
    process.platform === "darwin" ? `open "${escaped}"` :
    `xdg-open "${escaped}"`;

  exec(cmd, () => { /* ignore errors */ });
}
