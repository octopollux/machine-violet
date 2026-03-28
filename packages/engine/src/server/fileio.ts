/**
 * Base FileIO implementation using Node.js fs/promises.
 *
 * This is the production implementation; tests inject mocks.
 */
import { readFile, writeFile, appendFile, mkdir, access, readdir, unlink, rmdir } from "node:fs/promises";
import type { FileIO } from "../agents/scene-manager.js";

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
