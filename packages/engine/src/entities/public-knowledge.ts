/** Player-approved projection. Never expose a private record's body or fields. */
import type { CampaignKnowledgeStore } from "../knowledge/store.js";
import type { Compendium, CompendiumEntry, CompendiumCategory } from "@machine-violet/shared/types/compendium.js";
import type { KnowledgeNode, KnowledgeOutlineEntry } from "@machine-violet/shared/types/knowledge.js";
import { materializeKnowledgeValue } from "../knowledge/materialize.js";

export function collectionPath(parent: string | null, outline: KnowledgeOutlineEntry[]): string {
  const byUid = new Map(outline.map((entry) => [entry.uid, entry]));
  const names: string[] = [];
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const entry = byUid.get(parent);
    if (!entry) break;
    if (entry.parent !== null && entry.kind === "collection") names.unshift(entry.name);
    parent = entry.parent;
  }
  return names.join("/");
}
const publicSubject = (node: KnowledgeNode): string => {
  const value = node.fields.subject;
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.$ref === "string" ? value.$ref : node.uid;
};
const number = (value: unknown): number => typeof value === "number" ? value : 0;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Dynamic collections plus default presentation tabs, both containing approved prose only. */
export async function projectCampaignCompendium(store: CampaignKnowledgeStore): Promise<Compendium> {
  const result: Compendium = { version: 1, lastUpdatedScene: 0, characters: [], places: [], items: [], storyline: [], lore: [], objectives: [], collections: {} };
  const outline = await store.outline();
  const bySubject = new Map<string, { collection: string; entry: CompendiumEntry; approvedSummary: boolean }>();
  for (const item of outline) {
    if (item.kind !== "entity") continue;
    const node = await store.read(item.uid, { textLimit: 8000, logLimit: 0 });
    if (node.visibility !== "player-facing") continue;
    for (let offset = node.body.length; offset < node.textLength; offset += 8000) {
      node.body += (await store.read(node.uid, { textOffset: offset, textLimit: 8000, logLimit: 0 })).body;
    }
    for (const field of ["summary", "display_name", "public_aliases", "public_related"]) {
      if (node.fields[field] !== undefined) {
        const fieldUid = outline.find((entry) => entry.parent === node.uid && entry.name === field)?.uid;
        if (fieldUid) node.fields[field] = await materializeKnowledgeValue(store, node.fields[field], { rootUid: fieldUid, completeText: true, listLimit: Number.MAX_SAFE_INTEGER });
      }
    }
    const subject = publicSubject(node);
    const approvedSummary = typeof node.fields.summary === "string" && typeof node.fields.display_name === "string";
    const collection = collectionPath(node.parent, outline).replace(/^Player Knowledge\/?/, "") || "Campaign";
    const summary = approvedSummary ? String(node.fields.summary) : node.body;
    const name = approvedSummary ? String(node.fields.display_name) : node.name;
    const aliases = approvedSummary ? strings(node.fields.public_aliases) : node.aliases;
    // Only explicitly public references are rendered. Private dependency
    // labels and private subject fields never enter this projection.
    const related = Array.isArray(node.fields.public_related) ? node.fields.public_related.flatMap((value) => typeof value === "string" ? [value] : value && typeof value === "object" && !Array.isArray(value) && typeof value.$ref === "string" ? [value.$ref] : []) : [];
    const entry: CompendiumEntry = { uid: subject, slug: subject, name, aliases, summary, firstScene: number(node.fields.firstScene), lastScene: number(node.fields.lastScene), related };
    const prior = bySubject.get(subject);
    if (prior?.approvedSummary && approvedSummary) {
      // Several approved views can survive consolidation onto one canonical
      // UID. Keep their public handles without borrowing private aliases.
      entry.aliases = [...new Set([...(entry.aliases ?? []), prior.entry.name, ...(prior.entry.aliases ?? [])])].filter((alias) => alias !== entry.name);
      entry.related = [...new Set([...entry.related, ...prior.entry.related])];
    }
    if (!prior || approvedSummary || !prior.approvedSummary) bySubject.set(subject, { collection, entry, approvedSummary });
  }
  for (const { collection, entry } of bySubject.values()) {
    ((result.collections ??= {})[collection] ??= []).push(entry);
    result.lastUpdatedScene = Math.max(result.lastUpdatedScene, entry.lastScene);
    const top = collection.split("/")[0].toLocaleLowerCase();
    const categories: Partial<Record<string, CompendiumCategory>> = { characters: "characters", locations: "places", places: "places", items: "items", storyline: "storyline", lore: "lore", objectives: "objectives" };
    const category = categories[top];
    if (category) result[category].push(entry);
  }
  return result;
}

/** UID/name/alias lookup only within approved records; hidden identities return null. */
export async function readPublicCampaignRecord(store: CampaignKnowledgeStore, handle: string): Promise<{ uid: string; name: string; content: string; collection: string } | null> {
  const compendium = await projectCampaignCompendium(store);
  handle = handle.replace(/^@/, "").replace(/^knowledge:/, "");
  const normalized = handle.normalize("NFKC").trim().toLocaleLowerCase();
  // Old UID redirects can resolve a public identity, but a private alias must
  // never act as a lookup oracle for an otherwise hidden record.
  const uid = await store.resolveUid(handle);
  for (const [collection, entries] of Object.entries(compendium.collections ?? {})) {
    const entry = entries.find((candidate) => candidate.uid === handle || candidate.uid === uid || [candidate.name, ...(candidate.aliases ?? [])].some((name) => name.normalize("NFKC").trim().toLocaleLowerCase() === normalized));
    if (entry?.uid) return { uid: entry.uid, name: entry.name, content: `# ${entry.name}\n\n${entry.summary}`, collection };
  }
  return null;
}
