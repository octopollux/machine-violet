import { resolve, sep } from "node:path";
import type { FileIO } from "../../agents/scene-manager.js";

/**
 * Wrap a FileIO with path sandboxing.
 * Every path argument is resolved to an absolute path and checked against
 * the allowed roots. If the resolved path doesn't fall within any root,
 * the call throws before reaching the filesystem.
 *
 * @param inner - The underlying FileIO to delegate to
 * @param allowedRoots - Absolute directory paths the agent may access
 */
export function sandboxFileIO(inner: FileIO, allowedRoots: string[]): FileIO {
  if (allowedRoots.length === 0) {
    throw new Error("sandboxFileIO requires at least one allowed root");
  }

  const roots = allowedRoots.map((r) => resolve(r));

  function guard(p: string): string {
    const abs = resolve(p);
    const allowed = roots.some(
      (root) => abs === root || abs.startsWith(root + sep),
    );
    if (!allowed) {
      throw new Error(`Path outside sandbox: ${p}`);
    }
    return abs;
  }

  return {
    readFile: async (p) => inner.readFile(guard(p)),
    writeFile: async (p, c) => inner.writeFile(guard(p), c),
    appendFile: async (p, c) => inner.appendFile(guard(p), c),
    mkdir: async (p) => inner.mkdir(guard(p)),
    exists: async (p) => inner.exists(guard(p)),
    listDir: async (p) => inner.listDir(guard(p)),
    ...(inner.deleteFile ? { deleteFile: async (p: string) => inner.deleteFile!(guard(p)) } : {}),
  };
}
