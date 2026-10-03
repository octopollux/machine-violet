import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SqliteKnowledgeStore } from "../../../../packages/engine/src/knowledge/sqlite-store.js";
import { assertSupportedCampaign } from "../../../../packages/engine/src/tools/filesystem/config.js";
import type { TreeEntry } from "../shared/protocol.js";

export const isKnowledgeFile = (file: string): boolean => /(^|[/\\])knowledge\.sqlite(?:-(?:wal|shm|journal))?$/i.test(file);

/** Privileged local inspection only. Opens an existing database read-only and always releases it. */
export async function inspectKnowledge(root: string) {
  assertSupportedCampaign(JSON.parse(await readFile(join(root, "config.json"), "utf8")));
  const store = new SqliteKnowledgeStore(join(root, "knowledge.sqlite"), { create: false, readOnly: true });
  try {
    const outline = await store.outline();
    const byUid = new Map(outline.map((n) => [n.uid, n]));
    const nodes = new Map<string, Awaited<ReturnType<typeof store.read>>>();
    const fingerprints = new Map<string, string>();
    const entries: TreeEntry[] = [];
    for (const item of outline) {
      const node = await store.read(item.uid, { textLimit: 100_000, logLimit: 1000, childLimit: 1000 });
      for (let offset = 100_000; offset < node.textLength; offset += 100_000) {
        const page = await store.read(item.uid, { textOffset: offset, textLimit: 100_000, logLimit: 0, childLimit: 0 });
        node.body += page.body;
        if (typeof node.value === "string" && typeof page.value === "string") node.value += page.value;
      }
      for (let offset = 1000; offset < node.logCount; offset += 1000) {
        node.logs.push(...(await store.read(item.uid, { textLimit: 0, logOffset: offset, logLimit: 1000, childLimit: 0 })).logs);
      }
      for (const log of node.logs) {
        for (let offset = log.body.length; offset < (log.textLength ?? 0);) {
          const page = await store.read(item.uid, { textLimit: 0, logEntryId: log.id, logTextOffset: offset, logTextLimit: 100_000, childLimit: 0 });
          const text = page.logs[0]?.body ?? "";
          if (!text) break;
          log.body += text; offset += text.length;
        }
        delete log.textNextOffset;
      }
      delete node.textNextOffset; delete node.logNextOffset;
      nodes.set(node.uid, node);
      const names = [node.name];
      const seen = new Set([node.uid]);
      let parent = node.parent;
      while (parent && !seen.has(parent)) {
        seen.add(parent); const ancestor = byUid.get(parent); if (!ancestor) break;
        if (ancestor.parent !== null) names.unshift(ancestor.name);
        parent = ancestor.parent;
      }
      const logicalPath = names.join("/");
      const fingerprint = createHash("sha256").update(JSON.stringify({ node, logicalPath })).digest("hex");
      fingerprints.set(node.uid, fingerprint);
      if (node.parent === null) continue;
      entries.push({ relativePath: `knowledge/${node.uid}.json`, uid: node.uid, displayName: logicalPath, category: names.length > 1 ? names.slice(0, -1).join("/") : "Knowledge", size: JSON.stringify(node).length, mtime: fingerprint });
    }
    return { entries, nodes, fingerprints };
  } finally { await store.close(); }
}

export function changedKnowledge(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((uid) => before.get(uid) !== after.get(uid));
}
