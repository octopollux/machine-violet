/**
 * Base FileIO implementation using Node.js fs/promises.
 *
 * This is the production implementation; tests inject mocks.
 */
import { readFile, writeFile, appendFile, mkdir, access, readdir, unlink, rmdir, stat } from "node:fs/promises";
import type { FileIO } from "../agents/scene-manager.js";
import type { ArchiveFileIO } from "../config/campaign-archive.js";

export function createBaseFileIO(): FileIO {
  return {
    readFile: (path: string) => readFile(path, "utf-8"),
    writeFile: (path: string, content: string) => writeFile(path, content, "utf-8"),
    appendFile: (path: string, content: string) => appendFile(path, content, "utf-8"),
    mkdir: (path: string) => mkdir(path, { recursive: true }).then(() => { /* void */ }),
    exists: async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    listDir: (path: string) => readdir(path),
    deleteFile: (path: string) => unlink(path),
    rmdir: (path: string) => rmdir(path),
  };
}

/** Full I/O implementation for archive/delete operations (adds binary + stat). */
export function createArchiveFileIO(): ArchiveFileIO {
  return {
    readFile: (path: string) => readFile(path, "utf-8"),
    readBinary: (path: string) => readFile(path).then((buf) => new Uint8Array(buf)),
    writeFile: (path: string, content: string) => writeFile(path, content, "utf-8"),
    writeBinary: (path: string, data: Uint8Array) => writeFile(path, data),
    mkdir: (path: string) => mkdir(path, { recursive: true }).then(() => { /* void */ }),
    exists: async (path: string) => {
      try { await access(path); return true; } catch { return false; }
    },
    listDir: (path: string) => readdir(path),
    deleteFile: (path: string) => unlink(path),
    rmdir: (path: string) => rmdir(path),
    fileMtime: async (path: string) => {
      try { return (await stat(path)).mtime.toISOString(); } catch { return null; }
    },
    isDirectory: async (path: string) => {
      try { return (await stat(path)).isDirectory(); } catch { return false; }
    },
  };
}
