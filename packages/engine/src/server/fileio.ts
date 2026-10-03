import { writeAtomicFile } from "../utils/atomic-file.js";
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
  const stores = new Map<string, CampaignKnowledgeStore>();
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    campaignKnowledge: async (root, options) => {
      if (closed) throw new Error("Campaign I/O knowledge stores have been closed");
      const absolute = resolve(root);
      const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
      let store = stores.get(key);
      if (!store) {
        store = new SqliteKnowledgeStore(join(absolute, KNOWLEDGE_FILE), { create: options?.create ?? false });
        stores.set(key, store);
      }
      return store;
    },
    closeKnowledgeStores: () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const results = await Promise.allSettled([...stores.values()].map(async store => { await (store.dispose ? store.dispose() : store.close()); }));
        stores.clear();
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason as unknown);
        if (errors.length) throw new AggregateError(errors, "Failed to close campaign knowledge stores");
      })();
      return closing;
    },
    readFile: (path: string) => readFile(path, "utf-8"),
    writeFile: (path: string, content: string) => writeFile(path, content, "utf-8"),
    writeFileAtomic: writeAtomicFile,
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
