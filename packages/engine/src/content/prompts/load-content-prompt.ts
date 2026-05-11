/**
 * Prompt loader for content processing pipeline prompts.
 *
 * Separate from src/prompts/load-prompt.ts because these prompts live
 * in src/content/prompts/ and are only used by the processing pipeline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyModelConditionals } from "../../prompts/apply-model-conditionals.js";

const cache = new Map<string, string>();

function cacheKey(name: string, modelId: string | undefined): string {
  return `${name}\0${modelId ?? ""}`;
}

/**
 * Load a content processing prompt by name (without .md extension).
 * Cached after first load (keyed by name + modelId). CRLF normalized to LF.
 *
 * Pipeline: read → CRLF normalize → apply model conditionals. Unlike the
 * top-level loader, this one does not strip Obsidian-style `%% ...` comments
 * or HTML block comments — content prompts are not authored with comments.
 *
 * @param name - Prompt filename without .md extension.
 * @param modelId - Active model ID, used by `<!--if:PREFIX-->` conditionals.
 */
export function loadContentPrompt(name: string, modelId?: string): string {
  const key = cacheKey(name, modelId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const dir = import.meta.dirname;
  const filePath = join(dir, `${name}.md`);
  const raw = readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  const content = applyModelConditionals(raw, modelId);
  cache.set(key, content);
  return content;
}

/** Clear the prompt cache. For testing only. */
export function resetContentPromptCache(): void {
  cache.clear();
}
