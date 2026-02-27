import { watch, type FSWatcher } from "chokidar";
import { relative } from "node:path";
import type { FileChangeEvent, FileCategory } from "../shared/protocol.js";

/** Classify a relative path into a FileCategory. */
export function classifyPath(relPath: string): FileCategory {
  const normalized = relPath.replace(/\\/g, "/");

  if (normalized === "config.json") return "config";
  if (normalized.startsWith("state/")) return "state";
  if (normalized.endsWith("-thinking.json") && normalized.includes("context-dump"))
    return "thinking";
  if (normalized.includes("context-dump") && normalized.endsWith(".json"))
    return "context-dump";
  if (normalized.includes("/scenes/") && normalized.endsWith("transcript.md"))
    return "transcript";
  if (normalized.includes("/session-recaps/")) return "transcript";
  if (normalized.startsWith("campaign/")) return "transcript";
  if (normalized.endsWith(".json") && normalized.includes("map")) return "map";
  if (
    normalized.startsWith("characters/") ||
    normalized.startsWith("locations/") ||
    normalized.startsWith("factions/") ||
    normalized.startsWith("lore/") ||
    normalized.startsWith("rules/") ||
    normalized.startsWith("players/")
  )
    return "entity";

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
    ignored: [
      /(^|[/\\])\../, // dotfiles
      /node_modules/,
      /\.git/,
    ],
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

  watcher.on("add", (path) => emit("add", path));
  watcher.on("change", (path) => emit("change", path));
  watcher.on("unlink", (path) => emit("unlink", path));

  return watcher;
}
