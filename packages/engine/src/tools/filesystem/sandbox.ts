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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by ternary
    ...(inner.deleteFile ? { deleteFile: async (p: string) => inner.deleteFile!(guard(p)) } : {}),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by ternary
    ...(inner.writeBinaryFile ? { writeBinaryFile: async (p: string, b: Uint8Array) => inner.writeBinaryFile!(guard(p), b) } : {}),
    // readBinaryFile MUST be forwarded symmetrically with writeBinaryFile.
    // Dropping it silently breaks the DM PC-portrait inject: loadDmPortraitMessage
    // gates on `fileIO.readBinaryFile` and returns null when it's missing, so the
    // portrait never reaches the DM context (it just falls back to text). The
    // omission is invisible — images still persist (writeBinaryFile is here) — so
    // it surfaced only as generated characters drifting off-model.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by ternary
    ...(inner.readBinaryFile ? { readBinaryFile: async (p: string) => inner.readBinaryFile!(guard(p)) } : {}),
  };
}
