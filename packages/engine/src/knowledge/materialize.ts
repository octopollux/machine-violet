import type { KnowledgeValue } from "@machine-violet/shared/types/knowledge.js";
import type { CampaignKnowledgeStore } from "./store.js";

/** Deliberate bounded materialization of compact text/list descriptors. */
export async function materializeKnowledgeValue(store: CampaignKnowledgeStore, value: KnowledgeValue, limits: { textLimit?: number; listLimit?: number; rootUid?: string; completeText?: boolean } = {}): Promise<KnowledgeValue> {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Promise.all(value.map((child) => materializeKnowledgeValue(store, child, limits)));
  const descriptor = Object.keys(value).length === 2 && typeof value.length === "number" && ["$text", "$list", "$object"].some((key) => typeof value[key] === "string");
  if (!descriptor) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await materializeKnowledgeValue(store, child, limits)])));
  const marker = value.$text ?? value.$list ?? value.$object;
  if (typeof marker === "string" && limits.rootUid) {
    let uid: string | null = marker;
    const seen = new Set<string>();
    while (uid && uid !== limits.rootUid && !seen.has(uid)) {
      seen.add(uid);
      const node = await store.read(uid, { textLimit: 0, logLimit: 0, childLimit: 0 });
      if (node.kind !== "value") return value;
      uid = node.parent;
    }
    // Preview descriptors are trusted only inside the exact approved field
    // subtree. Authored objects that resemble markers remain ordinary data.
    if (uid !== limits.rootUid) return value;
  }
  if (typeof value.$text === "string" && typeof value.length === "number") {
    const node = await store.read(value.$text, { textLimit: limits.textLimit ?? 16000, logLimit: 0 });
    let text = typeof node.value === "string" ? node.value : node.body;
    if (limits.completeText) {
      for (let offset = text.length; offset < node.textLength; offset += 16000) {
        const page = await store.read(node.uid, { textOffset: offset, textLimit: 16000, logLimit: 0 });
        text += typeof page.value === "string" ? page.value : page.body;
      }
    }
    return text;
  }
  if (typeof value.$object === "string" && typeof value.length === "number") {
    const result: Record<string, KnowledgeValue> = {};
    const count = Math.min(value.length, limits.listLimit ?? 1000);
    for (let offset = 0; offset < count; offset += 100) {
      const page = await store.read(value.$object, { textLimit: 0, logLimit: 0, childOffset: offset, childLimit: Math.min(100, count - offset) });
      for (const child of page.children ?? []) {
        const node = await store.read(child.uid, { textLimit: limits.textLimit ?? 16000, logLimit: 0 });
        result[child.name] = await materializeKnowledgeValue(store, node.value ?? null, limits);
      }
    }
    return result;
  }
  if (typeof value.$list === "string" && typeof value.length === "number") {
    const result: KnowledgeValue[] = [];
    const count = Math.min(value.length, limits.listLimit ?? 1000);
    for (let offset = 0; offset < count; offset += 100) {
      const page = await store.read(value.$list, { textLimit: 0, logLimit: 0, childOffset: offset, childLimit: Math.min(100, count - offset) });
      for (const child of page.children ?? []) {
        const node = await store.read(child.uid, { textLimit: limits.textLimit ?? 16000, logLimit: 0 });
        result.push(await materializeKnowledgeValue(store, node.value ?? null, limits));
      }
    }
    return result;
  }
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await materializeKnowledgeValue(store, child, limits)])));
}
