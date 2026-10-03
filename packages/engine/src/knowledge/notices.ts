import type { KnowledgeNotice } from "@machine-violet/shared/types/knowledge.js";
/** Select whole durable notices; undelivered rows stay in the outbox. */
export function prepareKnowledgeNotices(pending: KnowledgeNotice[], budget = 8000): { notices: KnowledgeNotice[]; text: string } {
  const selected: KnowledgeNotice[] = [];
  const compact = (value: string, length: number) => value.replace(/[\r\n<>]/g, " ").slice(0, length);
  const render = (notices: KnowledgeNotice[]) => {
    const identities = new Map<string, KnowledgeNotice["identities"][number]>();
    const changed = new Set<string>(); const candidates = new Set<string>();
    for (const notice of notices) {
      notice.identities.forEach((identity) => {
        const prior = identities.get(identity.uid);
        identities.set(identity.uid, { ...identity, aliases: [...new Set([...(prior?.aliases ?? []), prior?.name, ...identity.aliases].filter((alias): alias is string => Boolean(alias) && alias !== identity.name))] });
      });
      notice.changed.forEach((uid) => changed.add(uid)); notice.candidates.forEach((uid) => candidates.add(uid));
    }
    const names = [...identities.values()].map((identity) => `${identity.uid}=${compact(identity.name, identity.name.length)}${identity.aliases.length ? ` (aka ${identity.aliases.map((alias) => compact(alias, alias.length)).join(", ")})` : ""}`);
    const unnamed = [...changed].filter((uid) => !identities.has(uid));
    return notices.length ? `Memory: ${[...names, ...unnamed].join("; ")}${candidates.size ? `; impacts: ${[...candidates].join(", ")}` : ""}` : "";
  };
  let text = "";
  for (const notice of pending) {
    const candidate = render([...selected, notice]);
    if (candidate.length > budget && selected.length) break;
    selected.push(notice); text = candidate;
    if (text.length >= budget) break;
  }
  return { notices: selected, text };
}
