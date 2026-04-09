/**
 * System catalog — known game systems and runtime discovery.
 *
 * Static typed array following the personalities.ts pattern.
 * Discovery merges bundled systems with user-processed systems at ~/.machine-violet/systems/.
 */

import type { FileIO } from "../agents/scene-manager.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { assetDir } from "../utils/paths.js";

export type SystemComplexity = "ultra-light" | "light" | "medium" | "high";

export interface SystemEntry {
  slug: string;
  name: string;
  /** True if systems/<slug>/ exists in the repo. */
  bundled: boolean;
  /** True if a bundled rule-card.md exists. */
  hasRuleCard: boolean;
  /** Mechanical complexity tier for grouping in system selection. */
  complexity: SystemComplexity;
  /** One-liner for choice descriptions in setup. */
  description: string;
}

export interface AvailableSystem extends SystemEntry {
  /** True if ~/.machine-violet/systems/<slug>/ exists (has been processed). */
  processed: boolean;
}

export const KNOWN_SYSTEMS: SystemEntry[] = [
  { slug: "24xx", name: "24XX", bundled: true, hasRuleCard: true, complexity: "ultra-light", description: "Micro-RPG framework. 3 skills, d6-d12 ladder." },
  { slug: "breathless", name: "Breathless", bundled: true, hasRuleCard: true, complexity: "light", description: "Degrading dice pools. Skills deplete as you use them." },
  { slug: "cairn", name: "Cairn", bundled: true, hasRuleCard: false, complexity: "light", description: "Into the Odd\u2013style. No to-hit rolls, direct damage." },
  { slug: "charge", name: "Charge RPG", bundled: true, hasRuleCard: true, complexity: "light", description: "Forged in the Dark\u2013lite. Action rolls + momentum." },
  { slug: "fate-accelerated", name: "FATE Accelerated", bundled: true, hasRuleCard: true, complexity: "light", description: "Approaches, aspects, fate points. Fiction-first." },
  { slug: "ironsworn", name: "Ironsworn", bundled: true, hasRuleCard: false, complexity: "medium", description: "Solo/co-op PbtA with iron vows and progress tracks." },
  { slug: "dnd-5e", name: "D&D 5th Edition", bundled: true, hasRuleCard: true, complexity: "high", description: "Classic d20 system. Classes, levels, spells, combat grid." },
];

/**
 * Resolve the path to the bundled systems/ directory.
 * Works from both src/ (dev via tsx) and dist/ (built).
 * Layout: repo-root/systems/<slug>/rule-card.md
 */
export function getBundledSystemsDir(): string {
  return assetDir("systems");
}

/**
 * Read a bundled rule card for a system. Returns null if not found.
 */
export function readBundledRuleCard(slug: string): string | null {
  const rcPath = join(getBundledSystemsDir(), slug, "rule-card.md");
  if (!existsSync(rcPath)) return null;
  return readFileSync(rcPath, "utf-8");
}

/**
 * Read the <character_creation> section from a system's bundled rule card.
 * Returns the inner text, or null if the section or rule card doesn't exist.
 */
export function readChargenSection(slug: string): string | null {
  const card = readBundledRuleCard(slug);
  if (!card) return null;
  const match = card.match(/<character_creation>([\s\S]*?)<\/character_creation>/);
  return match ? match[1].trim() : null;
}

/**
 * Find a known system by slug.
 */
export function findSystem(slug: string): SystemEntry | undefined {
  return KNOWN_SYSTEMS.find((s) => s.slug === slug);
}

/**
 * List all available systems: known systems merged with discovered
 * directories in homeDir/systems/.
 */
export async function listAvailableSystems(
  io: FileIO,
  homeDir: string,
): Promise<AvailableSystem[]> {
  const systemsDir = join(homeDir, "systems");
  let discoveredDirs: string[] = [];

  try {
    if (await io.exists(systemsDir)) {
      discoveredDirs = await io.listDir(systemsDir);
    }
  } catch {
    // systems dir missing or unreadable — continue with known only
  }

  const discoveredSet = new Set(discoveredDirs);

  // Start with known systems, mark as processed if discovered
  const result: AvailableSystem[] = KNOWN_SYSTEMS.map((s) => ({
    ...s,
    processed: discoveredSet.has(s.slug),
  }));

  // Add any discovered systems not in the known list
  for (const dir of discoveredDirs) {
    if (!KNOWN_SYSTEMS.some((s) => s.slug === dir)) {
      result.push({
        slug: dir,
        name: dir, // use slug as display name for custom systems
        bundled: false,
        hasRuleCard: false,
        complexity: "medium",
        description: "User-processed system.",
        processed: true,
      });
    }
  }

  return result;
}
