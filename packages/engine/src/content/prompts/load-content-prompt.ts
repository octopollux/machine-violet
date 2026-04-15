/**
 * Prompt loader for content processing pipeline prompts.
 *
 * Separate from src/prompts/load-prompt.ts because these prompts live
 * in src/content/prompts/ and are only used by the processing pipeline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, string>();

/**
 * Load a content processing prompt by name (without .md extension).
 * Cached after first load. CRLF normalized to LF.
 */
export function loadContentPrompt(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const dir = import.meta.dirname;
  const filePath = join(dir, `${name}.md`);
  const content = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  cache.set(name, content);
  return content;
}

/** Clear the prompt cache. For testing only. */
export function resetContentPromptCache(): void {
  cache.clear();
}
