import type { LLMProvider } from "../../providers/types.js";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getMaxOutput } from "../../config/model-registry.js";
import { loadPrompt } from "../../prompts/load-prompt.js";
import type { CampaignKnowledgeStore } from "../../knowledge/store.js";
import type { KnowledgeOperation } from "@machine-violet/shared/types/knowledge.js";

/**
 * Changelog updater subagent.
 * Scans a completed scene transcript and identifies entity changelog entries.
 *
 * @param client - Anthropic client
 * @param transcript - The completed scene transcript
 * @param sceneNumber - Scene number for reference
 * @param entityFiles - Canonical UID/name/alias list for matching
 * @returns Lines of "UID: changelog entry" (~50-200 tokens)
 */
export async function updateChangelogs(
  provider: LLMProvider,
  transcript: string,
  sceneNumber: number,
  entityFiles: string[],
  aliasContext: string | undefined,
  model: string,
): Promise<SubagentResult> {
  const prompt = `Scene ${sceneNumber} transcript:\n${transcript}\n\nKnown campaign identities:\n${entityFiles.join("\n")}${aliasContext ?? ""}\n\nList changelog entries for entities meaningfully involved.`;

  return oneShot(
    provider,
    model,
    loadPrompt("changelog-updater", model),
    prompt,
    getMaxOutput(model),
    "changelog-updater",
  );
}

export function parseChangelogEntries(text: string): string[] {
  return text.split("\n").filter((line) => line.includes(":")).map((line) => line.trim());
}

/** Resolve identities once, before the transition saves its exact mutation journal. */
export async function planChangelogEntries(
  store: CampaignKnowledgeStore,
  entries: string[],
  sceneNumber: number,
): Promise<KnowledgeOperation[]> {
  const operations: KnowledgeOperation[] = [];
  for (const entry of entries) {
    const separator = entry.indexOf(": ");
    if (separator < 0) continue;
    const handle = entry.slice(0, separator).trim();
    const body = entry.slice(separator + 2).trim();
    if (!handle || !body) continue;
    const uid = await store.resolve(handle);
    if (uid) operations.push({ op: "append_log", uid, body, metadata: { sceneNumber } });
  }
  return operations;
}
