/**
 * Velopack install/update/uninstall lifecycle hooks.
 *
 * Called from index.tsx when --veloapp-* args are detected.
 * Must exit within 30 seconds. No TUI, no interactive I/O.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

/**
 * Add or remove the app's install directory from the user PATH.
 *
 * Uses PowerShell to read/write the HKCU\Environment\Path registry value
 * and broadcasts WM_SETTINGCHANGE so new terminal sessions pick up the change.
 */
function updateUserPath(appDir: string, action: "add" | "remove"): void {
  // PowerShell script that modifies user PATH and broadcasts the change.
  // Runs entirely via registry — no setx (which truncates to 1024 chars).
  const ps = action === "add"
    ? `
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      $current = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
      $entries = $current -split ';' | Where-Object { $_ -ne '' }
      $dir = '${appDir.replace(/'/g, "''")}'
      if ($entries -notcontains $dir) {
        $new = ($entries + $dir) -join ';'
        $key.SetValue('Path', $new, 'ExpandString')
      }
      $key.Close()
      Add-Type -Namespace Win32 -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
      $out = [UIntPtr]::Zero
      [Win32.Env]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$out) | Out-Null
    `
    : `
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      $current = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
      $dir = '${appDir.replace(/'/g, "''")}'
      $new = ($current -split ';' | Where-Object { $_ -ne '' -and $_ -ne $dir }) -join ';'
      $key.SetValue('Path', $new, 'ExpandString')
      $key.Close()
      Add-Type -Namespace Win32 -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
      $out = [UIntPtr]::Zero
      [Win32.Env]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$out) | Out-Null
    `;

  execFileSync("powershell", ["-NoProfile", "-Command", ps], {
    stdio: "ignore",
    timeout: 15000,
  });
}

/**
 * Write to a log file next to the executable (for install diagnostics).
 */
function hookLog(appDir: string, message: string): void {
  try {
    const logDir = join(appDir, "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "velopack-hooks.log");
    const timestamp = new Date().toISOString();
    appendFileSync(logPath, `[${timestamp}] ${message}\n`);
  } catch {
    // Can't log — silently continue
  }
}

/**
 * Handle Velopack lifecycle hooks.
 *
 * MUST call process.exit() after handling — if the process continues
 * (starts Fastify, renders Ink), Velopack reports the hook as failed.
 */
export function handleVelopackHook(): void {
  if (process.platform !== "win32") return;

  const hook = process.argv.find((a) => a.startsWith("--veloapp-"));
  if (!hook) return;

  const appDir = dirname(process.execPath);
  hookLog(appDir, `Hook fired: ${hook}`);

  try {
    if (hook.startsWith("--veloapp-install") || hook.startsWith("--veloapp-updated")) {
      updateUserPath(appDir, "add");
      hookLog(appDir, `PATH updated (add): ${appDir}`);
    } else if (hook.startsWith("--veloapp-uninstall")) {
      updateUserPath(appDir, "remove");
      hookLog(appDir, `PATH updated (remove): ${appDir}`);
    }
  } catch (err) {
    hookLog(appDir, `Hook error: ${err instanceof Error ? err.message : String(err)}`);
    // Best-effort — don't block install/uninstall if PATH update fails
  }

  hookLog(appDir, "Hook complete, exiting.");
  process.exit(0);
}
