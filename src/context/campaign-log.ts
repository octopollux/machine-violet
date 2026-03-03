import { estimateTokens } from "./token-counter.js";

// --- Data Model ---

export interface CampaignLogEntry {
  sceneNumber: number;
  title: string;
  /** Bullet-list summary (existing format) */
  full: string;
  /** Dense one-liner (~25 words, preserving critical wikilinks) */
  mini: string;
}

export interface CampaignLog {
  campaignName: string;
  entries: CampaignLogEntry[];
}

// --- Rendering ---

const DEFAULT_TOKEN_BUDGET = 15000;

/**
 * Render a campaign log for inclusion in the DM system prompt.
 *
 * Deterministic: same JSON + same budget = same rendered string = API cache hit.
 * Walks scenes from newest to oldest, accumulating full entries until budget is
 * exceeded, then switches remaining older scenes to mini one-liners.
 */
export function renderCampaignLog(
  log: CampaignLog,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): string {
  if (log.entries.length === 0) return "";

  // Determine the cutoff: walk from newest to oldest
  let accumulated = 0;
  let cutoffIndex = 0; // scenes 0..cutoffIndex-1 render as mini

  for (let i = log.entries.length - 1; i >= 0; i--) {
    const fullTokens = estimateTokens(formatFullEntry(log.entries[i]));
    if (accumulated + fullTokens > tokenBudget && i < log.entries.length - 1) {
      // This entry would exceed budget and it's not the most recent scene
      cutoffIndex = i + 1;
      break;
    }
    accumulated += fullTokens;
  }

  const lines: string[] = [`# Campaign Log: ${log.campaignName}`];

  // Mini entries (older scenes)
  for (let i = 0; i < cutoffIndex; i++) {
    lines.push(formatMiniEntry(log.entries[i]));
  }

  // Full entries (recent scenes) — blank line between mini and full sections
  if (cutoffIndex > 0 && cutoffIndex < log.entries.length) {
    lines.push("");
  }

  for (let i = cutoffIndex; i < log.entries.length; i++) {
    lines.push(formatFullEntry(log.entries[i]));
  }

  return lines.join("\n");
}

/**
 * Format a full scene entry as a `## Scene` block with all bullets.
 */
export function formatFullEntry(entry: CampaignLogEntry): string {
  return `\n## Scene ${entry.sceneNumber}: ${entry.title}\n${entry.full}`;
}

/**
 * Format a mini scene entry as a single-line bullet.
 */
export function formatMiniEntry(entry: CampaignLogEntry): string {
  return `- Scene ${entry.sceneNumber}: ${entry.title} — ${entry.mini}`;
}

// --- Legacy Migration ---

/**
 * Parse legacy `log.md` markdown into a structured CampaignLog.
 *
 * Expected format:
 * ```
 * # Campaign Log: Name
 *
 * (optional premise paragraph)
 *
 * ## Scene 1: Title
 * - bullet one
 * - bullet two
 *
 * ## Scene 2: Title
 * ...
 * ```
 *
 * Scenes without entries are skipped. The campaign name is extracted from the
 * H1 header. Mini summaries are generated as the first bullet of each section.
 */
export function parseLegacyLog(markdown: string): CampaignLog {
  const lines = markdown.split("\n");

  let campaignName = "";
  const entries: CampaignLogEntry[] = [];

  // Extract campaign name from H1
  const h1Match = lines[0]?.match(/^#\s+Campaign Log:\s*(.+)/);
  if (h1Match) {
    campaignName = h1Match[1].trim();
  }

  // Parse scene sections
  let currentScene: { sceneNumber: number; title: string; bullets: string[] } | null = null;

  for (const line of lines) {
    const sceneMatch = line.match(/^##\s+Scene\s+(\d+):\s*(.+)/);
    if (sceneMatch) {
      // Flush previous scene
      if (currentScene && currentScene.bullets.length > 0) {
        entries.push(buildEntryFromBullets(currentScene));
      }
      currentScene = {
        sceneNumber: parseInt(sceneMatch[1], 10),
        title: sceneMatch[2].trim(),
        bullets: [],
      };
    } else if (currentScene && line.trim().startsWith("- ")) {
      currentScene.bullets.push(line);
    }
  }

  // Flush last scene
  if (currentScene && currentScene.bullets.length > 0) {
    entries.push(buildEntryFromBullets(currentScene));
  }

  return { campaignName, entries };
}

function buildEntryFromBullets(scene: { sceneNumber: number; title: string; bullets: string[] }): CampaignLogEntry {
  const full = scene.bullets.join("\n");
  // Fallback mini: first bullet stripped of leading "- "
  const firstBullet = scene.bullets[0]?.replace(/^-\s*/, "") ?? "";
  return {
    sceneNumber: scene.sceneNumber,
    title: scene.title,
    full,
    mini: firstBullet,
  };
}
