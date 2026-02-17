import type Anthropic from "@anthropic-ai/sdk";
import { oneShot } from "../subagent.js";
import type { SubagentResult } from "../subagent.js";
import { getModel } from "../../config/models.js";

const SYSTEM_PROMPT = `You identify entities meaningfully involved in a scene and write changelog entries.

Rules:
- Only include entities that were MEANINGFULLY involved (not just mentioned in passing).
- One line per entity, format: "entity_filename: changelog entry text"
- Changelog entries are terse: what happened to this entity in this scene.
- Include scene number reference.
- Do not include entities that were only mentioned in passing or as background.`;

/**
 * Changelog updater subagent.
 * Scans a completed scene transcript and identifies entity changelog entries.
 *
 * @param client - Anthropic client
 * @param transcript - The completed scene transcript
 * @param sceneNumber - Scene number for reference
 * @param entityFiles - List of known entity filenames for matching
 * @returns Lines of "filename: changelog entry" (~50-200 tokens)
 */
export async function updateChangelogs(
  client: Anthropic,
  transcript: string,
  sceneNumber: number,
  entityFiles: string[],
): Promise<SubagentResult> {
  const prompt = `Scene ${sceneNumber} transcript:\n${transcript}\n\nKnown entity files:\n${entityFiles.join("\n")}\n\nList changelog entries for entities meaningfully involved.`;

  return oneShot(
    client,
    getModel("small"),
    SYSTEM_PROMPT,
    prompt,
    512,
  );
}
