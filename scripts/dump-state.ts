#!/usr/bin/env npx tsx
/**
 * Dump persisted game state for debugging.
 *
 * Usage:
 *   npx tsx scripts/dump-state.ts [campaign-name]
 *
 * If campaign-name is omitted, lists available campaigns.
 * If provided, dumps all state/*.json files, pending-operation.json,
 * config.json, and the tail of campaign/log.md.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { defaultCampaignRoot } from "../packages/engine/src/tools/filesystem/platform.js";

// --- Resolve campaigns directory ---

function getCampaignsDir(): string {
  const configPath = join(process.cwd(), "config.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    if (config.campaigns_dir) return config.campaigns_dir;
  } catch {
    // fall through to default
  }
  return join(defaultCampaignRoot(), "campaigns");
}

function listCampaigns(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      const configPath = join(dir, name, "config.json");
      return existsSync(configPath);
    });
  } catch {
    return [];
  }
}

function readJsonPretty(path: string): string {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch (e) {
    return `(error reading: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return `... (${lines.length - n} lines omitted)\n` + lines.slice(-n).join("\n");
}

// --- Main ---

const campaignsDir = getCampaignsDir();
const requestedCampaign = process.argv[2];

if (!requestedCampaign) {
  const campaigns = listCampaigns(campaignsDir);
  if (campaigns.length === 0) {
    console.log(`No campaigns found in ${campaignsDir}`);
  } else {
    console.log(`Campaigns in ${campaignsDir}:\n`);
    for (const name of campaigns) {
      const stateDir = join(campaignsDir, name, "state");
      const hasState = existsSync(stateDir);
      console.log(`  ${name}${hasState ? "" : "  (no state/)"}`);
    }
    console.log(`\nUsage: npx tsx scripts/dump-state.ts <campaign-name>`);
  }
  process.exit(0);
}

const campaignRoot = join(campaignsDir, requestedCampaign);
if (!existsSync(join(campaignRoot, "config.json"))) {
  console.error(`Campaign not found: ${campaignRoot}`);
  console.error(`(No config.json in that directory)`);
  process.exit(1);
}

console.log(`=== Campaign: ${requestedCampaign} ===`);
console.log(`Root: ${campaignRoot}\n`);

// Campaign config
console.log(`--- config.json ---`);
console.log(readJsonPretty(join(campaignRoot, "config.json")));
console.log();

// State files
const stateFiles = [
  "state/combat.json",
  "state/clocks.json",
  "state/maps.json",
  "state/decks.json",
  "state/scene.json",
  "state/conversation.json",
  "state/ui.json",
];

for (const file of stateFiles) {
  const fullPath = join(campaignRoot, file);
  if (!existsSync(fullPath)) continue;
  const stat = statSync(fullPath);
  console.log(`--- ${file} --- (${stat.size} bytes, modified ${stat.mtime.toISOString()})`);
  console.log(readJsonPretty(fullPath));
  console.log();
}

// Pending operation (crash recovery)
const pendingOpPath = join(campaignRoot, "state", "pending-operation.json");
if (existsSync(pendingOpPath)) {
  console.log(`--- state/pending-operation.json --- (ACTIVE)`);
  console.log(readJsonPretty(pendingOpPath));
  console.log();
}

// Display log
const displayLogPath = join(campaignRoot, "state", "display-log.md");
if (existsSync(displayLogPath)) {
  const content = readFileSafe(displayLogPath);
  if (content) {
    console.log(`--- state/display-log.md --- (last 30 lines)`);
    console.log(tailLines(content, 30));
    console.log();
  }
}

// Campaign log tail
const campaignLogPath = join(campaignRoot, "campaign", "log.md");
if (existsSync(campaignLogPath)) {
  const content = readFileSafe(campaignLogPath);
  if (content) {
    console.log(`--- campaign/log.md --- (last 30 lines)`);
    console.log(tailLines(content, 30));
    console.log();
  }
}

// Scene directories — just list them
const scenesDir = join(campaignRoot, "campaign", "scenes");
if (existsSync(scenesDir)) {
  try {
    const scenes = readdirSync(scenesDir).sort();
    if (scenes.length > 0) {
      console.log(`--- Scenes ---`);
      for (const scene of scenes) {
        console.log(`  ${scene}/`);
      }
      console.log();
    }
  } catch {
    // ignore
  }
}
