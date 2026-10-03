import { describe, it, expect, vi } from "vitest";
import type { FileIO } from "../scene-manager.js";
import { buildSearchToolHandler } from "./search-campaign.js";
import { getCampaignKnowledge } from "../../knowledge/store.js";
function io(): FileIO {
  return { readFile: vi.fn(async (path) => path === "/camp/campaign/scenes/001-test/transcript.md" ? "Kael found the door." : Promise.reject(new Error("ENOENT"))), writeFile: vi.fn(), appendFile: vi.fn(), mkdir: vi.fn(), exists: vi.fn(async () => false), listDir: vi.fn(async () => []) };
}
const files = [{ relativePath: "campaign/scenes/001-test/transcript.md", content: "Kael found the door.\nThe door opened." }, { relativePath: "campaign/session-recaps/001.md", content: "Kael returned." }, { relativePath: "campaign/log.json", content: "Kael's arrival" }];
describe("campaign search", () => {
  it("searches narrative and arbitrary logical collections including long fields/logs", async () => {
    const fileIO = io(); const store = await getCampaignKnowledge("/camp", fileIO);
    await store.mutate([{ op: "create_collection", name: "Spells" }, { op: "create_collection", parent: "Spells", name: "Arcane" }, { op: "upsert", collection: "Spells/Arcane", name: "Firefly", fields: { description: "x".repeat(20000) + "door" }, history: "y".repeat(20000) + "distant beacon" }]);
    const handler = buildSearchToolHandler(files, fileIO, "/camp");
    const all = await handler("grep_campaign", { pattern: "DOOR" });
    expect(all.content).toContain("campaign/scenes/"); expect(all.content).toContain("Firefly");
    const entities = await handler("grep_campaign", { pattern: "door", file_filter: "entities" });
    expect(entities.content).toContain("knowledge:"); expect(entities.content).not.toContain("transcript.md");
    expect((await handler("knowledge", { action: "search", query: "distant beacon" })).content).toContain("Firefly");
    const uid = await store.resolve("Firefly"); const record = await handler("read_campaign_file", { path: `knowledge:${uid}` });
    expect(JSON.parse(record.content).uid).toBe(uid); expect(record.content.length).toBeLessThan(16000);
  });
  it.each(["scenes", "recaps", "log"])("filters %s narrative paths", async (filter) => {
    const result = await buildSearchToolHandler(files, io(), "/camp")("grep_campaign", { pattern: "kael", file_filter: filter });
    expect(result.content.split("\n")).toHaveLength(1);
  });
  it.each([".debug/context.md", "state/conversation.json", "campaign/../state/conversation.json", "characters/kael.md", "knowledge.sqlite"])("rejects raw private or unsupported file path %s", async (path) => {
    const fileIO = io(); const result = await buildSearchToolHandler(files, fileIO, "/camp")("read_campaign_file", { path });
    expect(result.is_error).toBe(true); expect(fileIO.readFile).not.toHaveBeenCalled();
  });
  it("reads narrative and reports missing or unknown requests", async () => {
    const handler = buildSearchToolHandler(files, io(), "/camp");
    expect((await handler("read_campaign_file", { path: "campaign/scenes/001-test/transcript.md" })).content).toContain("Kael found");
    expect((await handler("read_campaign_file", { path: "rules/missing.md" })).is_error).toBe(true);
    expect((await handler("unknown", {})).is_error).toBe(true);
    expect((await handler("grep_campaign", { pattern: "no such thing" })).content).toBe("No matches found.");
  });
});
