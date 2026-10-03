import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
/** Validate an archived/Git database before replacing any campaign files. */
export async function validateKnowledgeDatabaseBytes(bytes: Uint8Array): Promise<void> {
  if (bytes.length < 100 || new TextDecoder().decode(bytes.slice(0, 15)) !== "SQLite format 3" || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(60) !== 1)
    throw new Error("Snapshot has no supported campaign knowledge database");
  const root = await mkdtemp(join(tmpdir(), "mv-validate-knowledge-"));
  let inspector: SqliteKnowledgeStore | undefined;
  try {
    const path = join(root, "knowledge.sqlite");
    await writeFile(path, bytes);
    inspector = new SqliteKnowledgeStore(path, { readOnly: true, create: false });
    await inspector.outline();
  }
  finally {
    await inspector?.close();
    await rm(root, { recursive: true, force: true });
  }
}
