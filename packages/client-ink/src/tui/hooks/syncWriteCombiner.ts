/**
 * Combines synchronized terminal output (BSU/ESU) into single writes.
 *
 * Ink writes Begin Synchronized Update (\x1b[?2026h), content, and
 * End Synchronized Update (\x1b[?2026l]) as three separate
 * `stdout.write()` calls.  When these arrive as separate OS-level
 * writes, the terminal may briefly display intermediate states
 * (e.g. a cleared screen before new content), causing visible
 * corruption during rapid updates.
 *
 * This combiner intercepts `stdout.write()`, detects BSU sequences,
 * buffers all subsequent writes until ESU, then flushes the
 * accumulated buffer as a **single** `write()` call, ensuring the
 * terminal receives the entire synchronized update atomically.
 *
 * Optional `getPreEsuInjection` lets a caller splice extra escape sequences
 * into every synchronized block *just before* the ESU — used by the inline
 * image renderer to re-blit out-of-band graphics (sixel/iTerm2) inside the
 * same atomic frame Ink just drew, so the terminal never shows the blanked
 * intermediate state (see ../image/painterRegistry.ts). Returns "" when there
 * is nothing to inject, which is a no-op.
 */

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";

/** Insert `injection` immediately before the (last) ESU in `block`. */
function spliceBeforeEsu(block: string, injection: string): string {
  if (!injection) return block;
  const i = block.lastIndexOf(ESU);
  if (i === -1) return block;
  return block.slice(0, i) + injection + block.slice(i);
}

export function installSyncWriteCombiner(
  stream: NodeJS.WriteStream,
  getPreEsuInjection?: () => string,
): () => void {
  // Keep the true write and guard against double-install.
  const originalWrite: NodeJS.WriteStream["write"] = stream.write;
  const inject = getPreEsuInjection ?? (() => "");

  let syncChunks: string[] = [];
  let inSync = false;

  stream.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const str = typeof chunk === "string" ? chunk : String(chunk);

    // Detect BSU — may appear anywhere inside the chunk.
    if (!inSync && str.includes(BSU)) {
      inSync = true;
      syncChunks = [str];

      // Edge case: BSU + content + ESU all in one chunk — splice + pass through.
      if (str.includes(ESU)) {
        inSync = false;
        syncChunks = [];
        const block = spliceBeforeEsu(str, inject());
        return originalWrite.call(stream, block, encodingOrCb as BufferEncoding, cb) as boolean;
      }
      return true; // signal "accepted" to callers
    }

    if (inSync) {
      syncChunks.push(str);

      if (str.includes(ESU)) {
        // Flush the entire synchronized block as one write, splicing any
        // pre-ESU injection (inline-image escapes) inside the atomic frame.
        const combined = spliceBeforeEsu(syncChunks.join(""), inject());
        syncChunks = [];
        inSync = false;
        return originalWrite.call(stream, combined, encodingOrCb as BufferEncoding, cb) as boolean;
      }

      return true; // still buffering
    }

    // Outside BSU/ESU — pass through unchanged.
    return originalWrite.call(stream, chunk, encodingOrCb as BufferEncoding, cb) as boolean;
  } as NodeJS.WriteStream["write"];

  return () => {
    stream.write = originalWrite;
  };
}
