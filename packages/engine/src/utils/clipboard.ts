/**
 * Cross-platform clipboard support via `clipboardy`.
 *
 * - `copyToClipboard(text)` is the main entry point — never throws, returns boolean.
 * - `setClipboardIO()` swaps the implementation for tests.
 * - `clipboardy` is lazy-loaded so headless environments don't fail at import time.
 */

export interface ClipboardIO {
  write(text: string): Promise<void>;
  read(): Promise<string>;
}

let active: ClipboardIO | null = null;

/** Get the active ClipboardIO. Lazy-loads clipboardy on first call. */
async function getClipboardIO(): Promise<ClipboardIO> {
  if (active) return active;
  const { default: clipboard } = await import("clipboardy");
  active = {
    write: (text: string) => clipboard.write(text),
    read: () => clipboard.read(),
  };
  return active;
}

/**
 * Replace the active ClipboardIO (for tests).
 * Pass `null` to reset to default (lazy clipboardy).
 */
export function setClipboardIO(io: ClipboardIO | null): void {
  active = io;
}

/**
 * Copy text to the system clipboard.
 * Returns `true` on success, `false` on failure (e.g. no display server).
 * Never throws.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const io = await getClipboardIO();
    await io.write(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read text from the system clipboard.
 * Returns the clipboard contents, or `""` on failure.
 * Never throws.
 */
export async function readFromClipboard(): Promise<string> {
  try {
    const io = await getClipboardIO();
    return await io.read();
  } catch {
    return "";
  }
}
