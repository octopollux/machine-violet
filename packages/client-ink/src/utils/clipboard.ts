/**
 * Cross-platform clipboard write via `clipboardy`.
 *
 * Lazy-loaded so headless environments don't fail at import time.
 * Never throws — returns true on success, false on failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const { default: clipboard } = await import("clipboardy");
    await clipboard.write(text);
    return true;
  } catch {
    return false;
  }
}
