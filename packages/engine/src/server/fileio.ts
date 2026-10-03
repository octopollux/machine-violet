/**
 * Base FileIO implementation using Node.js fs/promises.
 *
 * This is the production implementation; tests inject mocks.
 */
import { readFile, writeFile, appendFile, mkdir, access, readdir, unlink, rmdir } from "node:fs/promises";
import type { FileIO } from "../agents/scene-manager.js";
import { join, resolve } from "node:path";
import { SqliteKnowledgeStore } from "../knowledge/sqlite-store.js";
import { KNOWLEDGE_FILE, type CampaignKnowledgeStore } from "../knowledge/store.js";

// createArchiveFileIO now lives with the archive operations it serves; re-export
// it here so existing `../fileio.js` importers (route handlers) are unaffected.
export { createArchiveFileIO } from "../config/campaign-archive.js";

export function createBaseFileIO(): FileIO {
  const stores = new Map<string,CampaignKnowledgeStore>();
  return {
    campaignKnowledge: async (root, options) => {
      const absolute=resolve(root); const key=process.platform==="win32" ? absolute.toLowerCase() : absolute;
      let store = stores.get(key);
      if(!store) { store=new SqliteKnowledgeStore(join(absolute,KNOWLEDGE_FILE),{create:options?.create ?? false}); stores.set(key,store); }
      return store;
    },
    readFile: (path: string) => readFile(path, "utf-8"),
    writeFile: (path: string, content: string) => writeFile(path, content, "utf-8"),
    writeBinaryFile: (path: string, bytes: Uint8Array) => writeFile(path, bytes),
    readBinaryFile: (path: string) => readFile(path).then((buf) => new Uint8Array(buf)),
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
