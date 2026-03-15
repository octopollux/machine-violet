/**
 * In-app update checker and installer.
 *
 * Checks GitHub releases for newer versions and can trigger
 * a self-update by downloading and replacing the installation.
 */

import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { isCompiled } from "../utils/paths.js";
import { getAppVersion } from "./first-launch.js";

const REPO = "Orthodox-531/machine-violet";

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;
  releaseUrl?: string;
}

/**
 * Check if a newer version is available on GitHub.
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = getAppVersion();

  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) {
      return { available: false, currentVersion, latestVersion: currentVersion };
    }

    const release = (await res.json()) as {
      tag_name: string;
      html_url: string;
      assets: { name: string; browser_download_url: string }[];
    };

    const latestVersion = release.tag_name.replace(/^v/, "");

    if (!isNewer(latestVersion, currentVersion)) {
      return { available: false, currentVersion, latestVersion };
    }

    // Find the right asset for this platform
    const platformKey = getPlatformKey();
    const asset = release.assets.find((a) =>
      a.name.includes(platformKey) &&
      (a.name.endsWith(".zip") || a.name.endsWith(".tar.gz")),
    );

    return {
      available: true,
      currentVersion,
      latestVersion,
      downloadUrl: asset?.browser_download_url,
      releaseUrl: release.html_url,
    };
  } catch {
    return { available: false, currentVersion, latestVersion: currentVersion };
  }
}

/**
 * Run the platform install script to perform the update.
 * On Windows, spawns a detached PowerShell process since the exe is locked.
 */
export function performUpdate(version: string): void {
  if (!isCompiled()) {
    throw new Error("Updates are only supported in the compiled binary.");
  }

  const exeDir = dirname(process.execPath);

  if (process.platform === "win32") {
    // Write a small update batch script that waits for the process to exit,
    // then runs the PowerShell install script
    const batPath = join(exeDir, ".update.cmd");
    const ps1Url = `https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1`;
    writeFileSync(batPath, [
      "@echo off",
      `echo Updating Machine Violet to v${version}...`,
      "timeout /t 2 /nobreak >nul",
      `powershell -ExecutionPolicy Bypass -Command "& { irm '${ps1Url}' | iex }" -Version ${version}`,
      `del "%~f0"`,
    ].join("\r\n"));

    // Spawn detached so it survives our exit
    execSync(`start "" /b cmd /c "${batPath}"`, { windowsHide: true });
  } else {
    const shUrl = `https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh`;
    execSync(
      `curl -fsSL "${shUrl}" | bash -s -- --version ${version}`,
      { stdio: "inherit" },
    );
  }
}

/** Compare semver strings. Returns true if `a` is newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

function getPlatformKey(): string {
  const os = process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "darwin"
    : "linux";
  return os;
}
