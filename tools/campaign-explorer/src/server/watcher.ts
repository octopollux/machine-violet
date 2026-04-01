import { watch, type FSWatcher } from "chokidar";
import { relative } from "node:path";
import type { FileChangeEvent, FileCategory } from "../shared/protocol.js";
import { MACHINE_SLUG } from "../shared/protocol.js";

/** Classify a relative path into a FileCategory. */
export function classifyPath(relPath: string): FileCategory {
  const normalized = relPath.replace(/\\/g, "/");

  if (normalized === "config.json") return "config";
  if (normalized.startsWith("state/")) return "state";
  // Context dumps: .debug/**/context/* or context-dump/* (legacy)
  const isContextPath = normalized.includes(".debug/") && normalized.includes("/context/");
  const isLegacyContextPath = normalized.includes("context-dump/");
  if (normalized.endsWith("-thinking.json") && (isContextPath || isLegacyContextPath))
    return "thinking";
  if (isContextPath || isLegacyContextPath) return "context-dump";
  // Crash logs and server log
  if (normalized.startsWith(".debug/") && normalized.endsWith(".txt")) return "logs";
  if (normalized.startsWith(".debug/") && normalized.endsWith(".log")) return "logs";
  if (normalized.startsWith(".debug/")) return "other";
  if (normalized.includes("/scenes/") && normalized.endsWith("transcript.md"))
    return "transcript";
  if (normalized.includes("/session-recaps/")) return "transcript";
  if (normalized.startsWith("campaign/")) return "transcript";
  if (normalized.endsWith(".json") && normalized.includes("map")) return "map";
  if (normalized.startsWith("characters/")) return "characters";
  if (normalized.startsWith("players/")) return "players";
  if (normalized.startsWith("locations/")) return "locations";
  if (normalized.startsWith("factions/")) return "factions";
  if (normalized.startsWith("lore/")) return "lore";
  if (normalized.startsWith("items/")) return "items";
  if (normalized.startsWith("rules/")) return "rules";

  return "other";
}

export interface WatcherOptions {
  onFileChange: (event: FileChangeEvent) => void;
}

/**
 * Watch a campaign directory for file changes.
 * Returns a cleanup function to stop watching.
 */
export function watchCampaign(
  campaignSlug: string,
  campaignDir: string,
  opts: WatcherOptions,
): FSWatcher {
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_MS = 200;

  const watcher = watch(campaignDir, {
    persistent: true,
    ignoreInitial: true,
    usePolling: process.platform === "win32",
    interval: 500,
    ignored: (path: string) => {
      const basename = path.split(/[/\\]/).pop() ?? "";
      if (basename === "node_modules") return true;
      // Allow .debug through; block all other dotfiles/dirs
      if (basename.startsWith(".") && basename !== ".debug") return true;
      return false;
    },
  });

  const emit = (changeType: "add" | "change" | "unlink", absPath: string) => {
    const relPath = relative(campaignDir, absPath).replace(/\\/g, "/");
    const key = `${campaignSlug}:${relPath}`;

    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        opts.onFileChange({
          type: "file-change",
          campaignSlug,
          relativePath: relPath,
          category: classifyPath(relPath),
          changeType,
        });
      }, DEBOUNCE_MS),
    );
  };

  watcher.on("all", (event, path) => {
    console.log(`[chokidar] ${event}: ${path}`);
  });
  watcher.on("add", (path) => emit("add", path));
  watcher.on("change", (path) => emit("change", path));
  watcher.on("unlink", (path) => emit("unlink", path));
  watcher.on("ready", () => console.log(`[chokidar] ready: ${campaignSlug} (polling=${process.platform === "win32"})`));
  watcher.on("error", (err) => console.error(`[chokidar] error (${campaignSlug}):`, err));

  return watcher;
}

/** Classify a file inside the machine-scope .debug/ directory. */
export function classifyMachinePath(relPath: string): FileCategory {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.endsWith(".log") || normalized.endsWith(".txt")) return "logs";
  if (normalized.endsWith("-thinking.json") && normalized.includes("/context/"))
    return "thinking";
  if (normalized.includes("/context/")) return "context-dump";
  return "other";
}

/**
 * Watch the machine-scope .debug/ directory for file changes.
 * These files are independent of any campaign.
 */
export function watchMachineDir(
  machineDir: string,
  opts: WatcherOptions,
): FSWatcher {
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_MS = 200;

  const watcher = watch(machineDir, {
    persistent: true,
    ignoreInitial: true,
    usePolling: process.platform === "win32",
    interval: 500,
  });

  const emit = (changeType: "add" | "change" | "unlink", absPath: string) => {
    const relPath = relative(machineDir, absPath).replace(/\\/g, "/");
    const key = `${MACHINE_SLUG}:${relPath}`;

    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        opts.onFileChange({
          type: "file-change",
          campaignSlug: MACHINE_SLUG,
          relativePath: relPath,
          category: classifyMachinePath(relPath),
          changeType,
        });
      }, DEBOUNCE_MS),
    );
  };

  watcher.on("all", (event, path) => {
    console.log(`[chokidar:machine] ${event}: ${path}`);
  });
  watcher.on("add", (path) => emit("add", path));
  watcher.on("change", (path) => emit("change", path));
  watcher.on("unlink", (path) => emit("unlink", path));
  watcher.on("ready", () => console.log(`[chokidar:machine] ready: ${machineDir}`));
  watcher.on("error", (err) => console.error(`[chokidar:machine] error:`, err));

  return watcher;
}
