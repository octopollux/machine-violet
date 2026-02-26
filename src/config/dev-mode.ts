import type { FileIO } from "../agents/scene-manager.js";

let cached: boolean | null = null;

/**
 * Check if dev mode is active (DEV_MODE=true in .env).
 * Result is cached after first call.
 */
export function isDevMode(): boolean {
  if (cached !== null) return cached;
  cached = process.env.DEV_MODE === "true";
  return cached;
}

/** Reset cached value (for tests). */
export function resetDevMode(): void {
  cached = null;
}

/**
 * Wrap a FileIO with dev logging on read/write/append.
 * Skips mkdir, exists, listDir (too noisy).
 */
export function wrapFileIOWithDevLog(
  io: FileIO,
  log: (msg: string) => void,
): FileIO {
  return {
    async readFile(path: string) {
      const content = await io.readFile(path);
      log(`[dev] file:read ${basename(path)} (${content.length} chars)`);
      return content;
    },
    async writeFile(path: string, content: string) {
      await io.writeFile(path, content);
      log(`[dev] file:write ${basename(path)} (${content.length} chars)`);
    },
    async appendFile(path: string, content: string) {
      await io.appendFile(path, content);
      log(`[dev] file:append ${basename(path)} (${content.length} chars)`);
    },
    mkdir: io.mkdir.bind(io),
    exists: io.exists.bind(io),
    listDir: io.listDir.bind(io),
  };
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}
