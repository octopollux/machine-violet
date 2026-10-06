import { stripCoDmAnnotations } from "./co-dm-protocol.js";

export type PublicTranscriptEntry =
  | { kind: "player"; speaker: string; text: string }
  | { kind: "dm"; text: string };

/** Entries are whole source messages, never lines: tool continuations stay private. */
export function projectPublicTranscript(entries: readonly string[]): PublicTranscriptEntry[] {
  const result: PublicTranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.startsWith("**DM:**")) {
      const text = stripCoDmAnnotations(entry.slice("**DM:**".length).trimStart()).publicText;
      if (text) result.push({ kind: "dm", text });
      continue;
    }
    const player = /^\*\*\[([^\]\r\n]+)\]\*\*\s*/.exec(entry);
    if (player) {
      const text = entry.slice(player[0].length);
      if (text) result.push({ kind: "player", speaker: player[1], text });
    }
    // Tools, operator diagnostics and unknown entry kinds fail closed.
  }
  return result;
}

export function renderPublicTranscript(entries: readonly PublicTranscriptEntry[]): string[] {
  return entries.map(entry => entry.kind === "dm" ? `**DM:** ${entry.text}` : `**[${entry.speaker}]** ${entry.text}`);
}

/** Approved names only. Canonical private aliases are never supplied to public helpers. */
export function renderPublicIdentityContext(entries: readonly { uid?: string; name: string; aliases?: string[] }[]): string {
  const lines = entries.map(entry => `${entry.uid ?? "public"}: ${entry.name}${entry.aliases?.length ? ` (also ${entry.aliases.join(", ")})` : ""}`);
  return lines.length ? `Approved public identities (use these names only):\n${lines.join("\n")}` : "";
}
