import { describe, it, expect } from "vitest";
import { prepareKnowledgeNotices } from "./notices.js";
import type { KnowledgeNotice } from "@machine-violet/shared/types/knowledge.js";
const notice = (id: number, name: string, aliases: string[]): KnowledgeNotice => ({ id, source: "background", changed: ["k0006"], identities: [{ uid: "k0006", name, aliases }], candidates: ["k0007", "k0008"] });
describe("terse committed feedback", () => {
  it("coalesces repeated writes with latest names, meaningful aliases and deduplicated impacts", () => {
    const result = prepareKnowledgeNotices([notice(1, "Shadowy Figure", ["Tall Hat"]), notice(2, "Bob", ["Bob", "Tall Hat"])]);
    expect(result.text).toBe("Memory: k0006=Bob (aka Tall Hat, Shadowy Figure); impacts: k0007, k0008");
    expect(result.notices.map((entry) => entry.id)).toEqual([1, 2]);
  });
  it("keeps whole undelivered rows pending for subsequent normal turns", () => {
    const pending = Array.from({ length: 100 }, (_, index) => ({ ...notice(index, `Name ${index}`, []), changed: [`k${index}`], identities: [{ uid: `k${index}`, name: `Name ${index}`, aliases: [] }] }));
    const first = prepareKnowledgeNotices(pending, 300);
    expect(first.text.length).toBeLessThanOrEqual(300); expect(first.notices.length).toBeGreaterThan(0); expect(first.notices.length).toBeLessThan(100);
    const delivered = new Set(first.notices.map((entry) => entry.id));
    const second = prepareKnowledgeNotices(pending.filter((entry) => !delivered.has(entry.id)), 300);
    expect(second.notices[0].id).toBe(first.notices.length);
  });
});
