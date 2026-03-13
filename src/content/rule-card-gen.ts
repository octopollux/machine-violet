/**
 * Stage 5: Rule Card Generation — generate rule-card.md if none exists.
 *
 * Skips if a hand-authored rule card exists at systems/<collection-slug>/rule-card.md.
 * Otherwise, reads extracted rules entities and generates a rule card
 * using Haiku/Sonnet with few-shot examples from bundled systems.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { FileIO } from "../agents/scene-manager.js";
import { getModel } from "../config/models.js";
import { oneShot } from "../agents/subagent.js";
import { processingPaths } from "./processing-paths.js";
import { loadContentPrompt } from "./prompts/load-content-prompt.js";

/**
 * Check if a hand-authored rule card exists for this collection.
 *
 * @param projectRoot - Root of the project (where systems/ lives).
 * @param collectionSlug - e.g. "d-d-5e"
 */
export function hasHandAuthoredRuleCard(projectRoot: string, collectionSlug: string): boolean {
  const ruleCardPath = join(projectRoot, "systems", collectionSlug, "rule-card.md");
  return existsSync(ruleCardPath);
}

/**
 * Load bundled rule cards as few-shot examples.
 * Reads all rule-card.md files from systems/ subdirectories.
 */
export function loadFewShotExamples(projectRoot: string): string[] {
  const systemsDir = join(projectRoot, "systems");
  if (!existsSync(systemsDir)) return [];

  const examples: string[] = [];
  try {
    const dirs = readdirSync(systemsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const rcPath = join(systemsDir, dir.name, "rule-card.md");
      if (existsSync(rcPath)) {
        examples.push(readFileSync(rcPath, "utf-8"));
      }
    }
  } catch {
    // If systems dir is missing or unreadable, continue with no examples
  }

  return examples;
}

/**
 * Load rules entities from the processed entities directory.
 */
async function loadRulesEntities(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
): Promise<string> {
  const paths = processingPaths(homeDir, collectionSlug);
  const rulesDir = paths.entityCategoryDir("rules");

  if (!(await io.exists(rulesDir))) return "";

  const files = await io.listDir(rulesDir);
  const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

  const contents: string[] = [];
  for (const f of mdFiles) {
    const filePath = paths.entityFile("rules", f.replace(/\.md$/, ""));
    const text = await io.readFile(filePath);
    contents.push(text);
  }

  return contents.join("\n\n---\n\n");
}

/**
 * Generate a rule card from extracted rules entities.
 */
export async function generateRuleCard(
  client: Anthropic,
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
  projectRoot: string,
): Promise<string> {
  const systemPrompt = loadContentPrompt("rule-card-gen");
  const rulesText = await loadRulesEntities(io, homeDir, collectionSlug);

  // Build user message with few-shot examples
  const examples = loadFewShotExamples(projectRoot);
  let userMessage = "";

  if (examples.length > 0) {
    userMessage += "## Example rule cards for reference\n\n";
    for (const [i, ex] of examples.entries()) {
      userMessage += `### Example ${i + 1}\n\n${ex}\n\n`;
    }
  }

  userMessage += "## Source rules to synthesize\n\n";
  userMessage += rulesText || "*No rules entities available — generate a minimal template.*";

  const result = await oneShot(
    client,
    getModel("small"),
    systemPrompt,
    userMessage,
    8192,
    "rule-card-gen",
  );

  return result.text;
}

/**
 * Run Stage 5: generate rule card if no hand-authored one exists.
 * Returns true if a rule card was generated, false if skipped.
 */
export async function runRuleCardGen(
  client: Anthropic,
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
  projectRoot: string,
): Promise<boolean> {
  // Skip if hand-authored rule card exists
  if (hasHandAuthoredRuleCard(projectRoot, collectionSlug)) {
    return false;
  }

  const paths = processingPaths(homeDir, collectionSlug);
  const content = await generateRuleCard(client, io, homeDir, collectionSlug, projectRoot);
  await io.mkdir(paths.base);
  await io.writeFile(paths.ruleCard, content);
  return true;
}
