import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** Replace a complete file only after its sibling temporary file is synced. */
export async function writeAtomicFile(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); }
    catch { /* Best-effort cleanup must not mask the write/replace failure. */ }
  }
}
