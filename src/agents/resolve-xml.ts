import type { StateDelta, RollRecord } from "../types/resolve-session.js";

export interface ParsedResolution {
  narrative: string;
  deltas: StateDelta[];
  rolls: RollRecord[];
}

/**
 * Parse a <resolution> XML block from the resolve session's output.
 * Returns null if no valid block found (graceful fallback — DM handles manually).
 */
export function parseResolutionXml(text: string): ParsedResolution | null {
  const blockMatch = text.match(/<resolution>([\s\S]*?)<\/resolution>/);
  if (!blockMatch) return null;

  const block = blockMatch[1];

  // Extract narrative
  const narrativeMatch = block.match(/<narrative>([\s\S]*?)<\/narrative>/);
  const narrative = narrativeMatch ? narrativeMatch[1].trim() : "";

  // Extract rolls
  const rolls: RollRecord[] = [];
  const rollRegex = /<roll\s+([^/>]*?)\/?\s*>/g;
  let rollMatch;
  while ((rollMatch = rollRegex.exec(block)) !== null) {
    const attrs = rollMatch[1];
    rolls.push({
      expression: extractAttr(attrs, "expr") ?? "",
      reason: extractAttr(attrs, "reason") ?? "",
      result: Number(extractAttr(attrs, "result") ?? "0"),
      detail: extractAttr(attrs, "detail") ?? "",
    });
  }

  // Extract deltas
  const deltas: StateDelta[] = [];
  const deltaRegex = /<delta\s+([^/>]*?)\/?\s*>/g;
  let deltaMatch;
  while ((deltaMatch = deltaRegex.exec(block)) !== null) {
    const attrs = deltaMatch[1];
    const type = extractAttr(attrs, "type") as StateDelta["type"] | null;
    const target = extractAttr(attrs, "target");
    if (!type || !target) continue;

    // Build details from remaining attributes
    const details: Record<string, unknown> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrs)) !== null) {
      const key = attrMatch[1];
      if (key === "type" || key === "target") continue;
      // Try to parse numbers
      const val = attrMatch[2];
      const num = Number(val);
      details[key] = isNaN(num) ? val : num;
    }

    deltas.push({ type, target, details });
  }

  return { narrative, deltas, rolls };
}

/** Extract a single XML attribute value by name. */
function extractAttr(attrString: string, name: string): string | null {
  const match = attrString.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}
