/**
 * FileIO wrapper that emits debug log messages on read/write/append.
 * Always active — debug output until 1.0.
 */
import type { FileIO } from "../agents/scene-manager.js";

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function wrapFileIOWithDevLog(
  io: FileIO,
  log: (msg: string) => void,
): FileIO {
  return {
    async readFile(path: string) {
      const content = await io.readFile(path);
      log(`[debug] file:read ${basename(path)} (${content.length} chars)`);
      return content;
    },
    async writeFile(path: string, content: string) {
      await io.writeFile(path, content);
      log(`[debug] file:write ${basename(path)} (${content.length} chars)`);
    },
    async appendFile(path: string, content: string) {
      await io.appendFile(path, content);
      log(`[debug] file:append ${basename(path)} (${content.length} chars)`);
    },
    mkdir: io.mkdir.bind(io),
    exists: io.exists.bind(io),
    listDir: io.listDir.bind(io),
    ...(io.deleteFile ? { deleteFile: io.deleteFile.bind(io) } : {}),
    ...(io.rmdir ? { rmdir: io.rmdir.bind(io) } : {}),
  };
}
