import { describe,it,expect,vi } from "vitest";
import type { FileIO } from "../../agents/scene-manager.js";
import type { LLMProvider } from "../../providers/types.js";
import { SqliteKnowledgeStore } from "../../knowledge/sqlite-store.js";
import {levenshtein,computeNearMatches,parseTriageResponse,resolveDeadLinks} from "./resolve-dead-links.js";
describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("returns length of other string when one is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("hello", "")).toBe(5);
  });

  it("computes known distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("kael", "keal")).toBe(2);
    expect(levenshtein("a", "b")).toBe(1);
  });

  it("handles single character strings", () => {
    expect(levenshtein("a", "a")).toBe(0);
    expect(levenshtein("a", "b")).toBe(1);
  });
});

// --- Unit tests: computeNearMatches ---

describe("computeNearMatches", () => {
  it("scores identical basenames in different dirs at ~0.9", () => {
    const matches = computeNearMatches(
      "characters/kael.md",
      ["factions/kael.md", "lore/unrelated.md"],
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].path).toBe("factions/kael.md");
    expect(matches[0].score).toBeCloseTo(0.9, 1);
  });

  it("scores prefix match at ~0.7", () => {
    const matches = computeNearMatches(
      "characters/kael.md",
      ["characters/kael-ranger.md"],
    );
    expect(matches.length).toBe(1);
    // "kael" is prefix of "kael-ranger" → 0.7, plus directory bonus 0.1 = 0.8
    expect(matches[0].score).toBeCloseTo(0.8, 1);
  });

  it("returns empty for no matches above minScore", () => {
    const matches = computeNearMatches(
      "characters/kael.md",
      ["locations/tavern/index.md", "lore/cosmology.md"],
    );
    expect(matches).toEqual([]);
  });

  it("respects maxCandidates", () => {
    const matches = computeNearMatches(
      "characters/kael.md",
      ["factions/kael.md", "lore/kael.md", "locations/kael.md", "characters/kaela.md"],
      2,
    );
    expect(matches.length).toBe(2);
  });

  it("adds directory prefix bonus", () => {
    const sameDir = computeNearMatches(
      "characters/kael.md",
      ["characters/kaeel.md"],
    );
    const diffDir = computeNearMatches(
      "characters/kael.md",
      ["factions/kaeel.md"],
    );
    // Same dir should score higher due to +0.1 bonus
    if (sameDir.length > 0 && diffDir.length > 0) {
      expect(sameDir[0].score).toBeGreaterThan(diffDir[0].score);
    }
  });

  it("clamps score at 1.0 with directory bonus", () => {
    // Identical basename in same dir → 0.9 + 0.1 = 1.0
    const matches = computeNearMatches(
      "characters/kael.md",
      ["characters/kael.md"],
    );
    expect(matches.length).toBe(1);
    expect(matches[0].score).toBe(1.0);
  });
});

// --- Unit tests: parseTriageResponse ---

describe("parseTriageResponse", () => {
  it("parses valid JSON array", () => {
    const json = JSON.stringify([
      { path: "characters/kael.md", category: "stub", reason: "Only mentioned once." },
      { path: "factions/guild.md", category: "missing", reason: "Discussed in 3 scenes." },
    ]);
    const result = parseTriageResponse(json);
    expect(result).toHaveLength(2);
    expect(result[0].category).toBe("stub");
    expect(result[1].category).toBe("missing");
  });

  it("parses code-fenced JSON", () => {
    const fenced = "```json\n" + JSON.stringify([
      { path: "characters/kael.md", category: "repoint", reason: "Renamed.", repoint_target: "characters/kael-ranger.md" },
    ]) + "\n```";
    const result = parseTriageResponse(fenced);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("repoint");
    expect(result[0].repointTarget).toBe("characters/kael-ranger.md");
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseTriageResponse("not json at all")).toEqual([]);
    expect(parseTriageResponse("{invalid}")).toEqual([]);
    expect(parseTriageResponse("")).toEqual([]);
  });

  it("validates required fields", () => {
    const json = JSON.stringify([
      { path: "a.md", category: "stub" }, // missing reason
      { path: "b.md", reason: "ok" },     // missing category
      { category: "stub", reason: "ok" }, // missing path
      { path: "c.md", category: "stub", reason: "Valid." }, // valid
    ]);
    const result = parseTriageResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].resolvedPath).toBe("c.md");
  });

  it("rejects invalid categories", () => {
    const json = JSON.stringify([
      { path: "a.md", category: "unknown", reason: "Bad." },
    ]);
    expect(parseTriageResponse(json)).toEqual([]);
  });
});

// --- Integration tests ---

describe("resolveDeadLinks",()=>{
  it("relies on committed graph integrity without model calls or repairs",async()=>{
    const store=new SqliteKnowledgeStore(":memory:");const io={campaignKnowledge:async()=>store} as FileIO;
    const provider={chat:vi.fn()} as unknown as LLMProvider;
    await expect(store.mutate([{op:"upsert",collection:"Lore",name:"Plot",fields:{hero:{$ref:"Missing"}}}])).rejects.toThrow("Unknown");
    const result=await resolveDeadLinks("/camp",io,provider,"context",false);
    expect(result.deadLinks).toEqual([]);expect(result.filesGenerated).toEqual([]);expect(provider.chat).not.toHaveBeenCalled();
  });
});
