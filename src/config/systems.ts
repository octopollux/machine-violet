/**
 * System catalog — known game systems and runtime discovery.
 *
 * Static typed array following the seeds.ts / personalities.ts pattern.
 * Discovery merges bundled systems with user-processed systems at ~/.machine-violet/systems/.
 */

import type { FileIO } from "../agents/scene-manager.js";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface SystemEntry {
  slug: string;
  name: string;
  /** True if systems/<slug>/ exists in the repo. */
  bundled: boolean;
  /** True if a bundled rule-card.md exists. */
  hasRuleCard: boolean;
}

export interface AvailableSystem extends SystemEntry {
  /** True if ~/.machine-violet/systems/<slug>/ exists (has been processed). */
  processed: boolean;
}

export const KNOWN_SYSTEMS: SystemEntry[] = [
  { slug: "24xx", name: "24XX", bundled: true, hasRuleCard: true },
  { slug: "fate-accelerated", name: "FATE Accelerated", bundled: true, hasRuleCard: true },
  { slug: "cairn", name: "Cairn", bundled: true, hasRuleCard: false },
  { slug: "ironsworn", name: "Ironsworn", bundled: true, hasRuleCard: false },
  { slug: "breathless", name: "Breathless", bundled: true, hasRuleCard: true },
  { slug: "charge", name: "Charge RPG", bundled: true, hasRuleCard: true },
  { slug: "dnd-5e", name: "D&D 5th Edition", bundled: true, hasRuleCard: true },
];

/**
 * Resolve the path to the bundled systems/ directory.
 * Works from both src/ (dev via tsx) and dist/ (built).
 * Layout: repo-root/systems/<slug>/rule-card.md
 */
export function getBundledSystemsDir(): string {
  // src/config/systems.ts → ../../systems/
  // dist/config/systems.js → ../../systems/
  return join(import.meta.dirname, "..", "..", "systems");
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
        processed: true,
      });
    }
  }

  return result;
}
