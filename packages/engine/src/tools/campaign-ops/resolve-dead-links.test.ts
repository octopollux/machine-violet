import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage } from "../../providers/types.js";
import type { FileIO } from "../../agents/scene-manager.js";
import { loadModelConfig } from "../../config/models.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import {
  levenshtein,
  computeNearMatches,
  parseTriageResponse,
  resolveDeadLinks,
} from "./resolve-dead-links.js";

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetPromptCache();
});

// --- Test helpers ---

function mockFileIO(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
): FileIO {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => p in files || p in dirs),
    listDir: vi.fn(async (p: string) => {
      if (p in dirs) return dirs[p];
      return [];
    }),
    deleteFile: vi.fn(async () => {}),
  };
}

function mockUsage(): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textResult(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function mockProvider(responses: ChatResult[]): LLMProvider {
  let callIdx = 0;
  return {
    providerId: "test",
    chat: vi.fn(async () => responses[callIdx++] ?? responses[responses.length - 1]),
    stream: vi.fn(async (_params, onDelta) => {
      const result = responses[callIdx++] ?? responses[responses.length - 1];
      if (result.text) onDelta(result.text);
      return result;
    }),
    healthCheck: vi.fn(),
  };
}

// --- Unit tests: levenshtein ---

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

describe("resolveDeadLinks", () => {
  const ROOT = "/campaigns/test";

  function setupCampaign(files: Record<string, string>, dirs: Record<string, string[]>) {
    return mockFileIO(files, dirs);
  }

  it("finds dead links and sends to Haiku for triage", async () => {
    const fio = setupCampaign(
      {
        "/campaigns/test/characters/kael.md": "# Kael\n**Type:** PC\nMet [Goblin](../characters/goblin.md).",
      },
      {
        "/campaigns/test/characters": ["kael.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    const triageResponse = JSON.stringify([
      { path: "characters/goblin.md", category: "stub", reason: "Mentioned in passing." },
    ]);
    const provider = mockProvider([textResult(triageResponse)]);

    const result = await resolveDeadLinks(ROOT, fio, provider, "Just checking", true);

    expect(result.deadLinks).toHaveLength(1);
    expect(result.deadLinks[0].resolvedPath).toBe("characters/goblin.md");
    expect(result.triaged.stubs).toHaveLength(1);
    expect(provider.chat).toHaveBeenCalled();
  });

  it("dry-run returns report without writing", async () => {
    const fio = setupCampaign(
      {
        "/campaigns/test/characters/kael.md": "# Kael\n[Missing](../characters/ghost.md)",
      },
      {
        "/campaigns/test/characters": ["kael.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    const triageResponse = JSON.stringify([
      { path: "characters/ghost.md", category: "missing", reason: "Discussed enough." },
    ]);
    const provider = mockProvider([textResult(triageResponse)]);

    const result = await resolveDeadLinks(ROOT, fio, provider, "Check it", true);

    expect(result.dryRun).toBe(true);
    expect(result.filesUpdated).toEqual([]);
    expect(result.filesGenerated).toEqual([]);
    expect(fio.writeFile).not.toHaveBeenCalled();
  });

  it("repoints update links when dryRun=false", async () => {
    const fio = setupCampaign(
      {
        "/campaigns/test/characters/kael-ranger.md": "# Kael the Ranger",
        "/campaigns/test/campaign/log.md": "Met [Kael](../characters/kael.md) at tavern.",
      },
      {
        "/campaigns/test/characters": ["kael-ranger.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    const triageResponse = JSON.stringify([
      { path: "characters/kael.md", raw_target: "../characters/kael.md", category: "repoint", reason: "Renamed.", repoint_target: "characters/kael-ranger.md" },
    ]);
    const provider = mockProvider([textResult(triageResponse)]);

    const result = await resolveDeadLinks(ROOT, fio, provider, "Renamed kael to kael-ranger", false);

    expect(result.dryRun).toBe(false);
    expect(result.triaged.repoints).toHaveLength(1);
    expect(result.filesUpdated.length).toBeGreaterThanOrEqual(1);
    expect(fio.writeFile).toHaveBeenCalled();
  });

  it("missing entities generate stubs when dryRun=false", async () => {
    const fio = setupCampaign(
      {
        "/campaigns/test/characters/kael.md": "# Kael\nVisited [Tavern](../locations/tavern/index.md).",
      },
      {
        "/campaigns/test/characters": ["kael.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    const triageResponse = JSON.stringify([
      { path: "locations/tavern/index.md", category: "missing", reason: "Major location." },
    ]);
    const genResponse = "===locations/tavern/index.md===\n# The Tavern\n**Type:** Location\n";
    const provider = mockProvider([textResult(triageResponse), textResult(genResponse)]);

    const result = await resolveDeadLinks(ROOT, fio, provider, "Need tavern", false);

    expect(result.triaged.missing).toHaveLength(1);
    expect(result.filesGenerated).toContain("locations/tavern/index.md");
    expect(fio.mkdir).toHaveBeenCalled();
    expect(fio.writeFile).toHaveBeenCalled();
  });

  it("stubs left untouched (no writes)", async () => {
    const fio = setupCampaign(
      {
        "/campaigns/test/characters/kael.md": "# Kael\nMet [Bob](../characters/bob.md).",
      },
      {
        "/campaigns/test/characters": ["kael.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    const triageResponse = JSON.stringify([
      { path: "characters/bob.md", category: "stub", reason: "Mentioned once." },
    ]);
    const provider = mockProvider([textResult(triageResponse)]);

    const result = await resolveDeadLinks(ROOT, fio, provider, "Check", true);

    expect(result.triaged.stubs).toHaveLength(1);
    expect(result.filesUpdated).toEqual([]);
    expect(result.filesGenerated).toEqual([]);
    expect(fio.writeFile).not.toHaveBeenCalled();
  });

  it("empty campaign returns empty result", async () => {
    const fio = setupCampaign(
      {},
      {
        "/campaigns/test/characters": [],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    const provider = mockProvider([]);

    const result = await resolveDeadLinks(ROOT, fio, provider, "Nothing here");

    expect(result.deadLinks).toEqual([]);
    expect(result.triaged.stubs).toEqual([]);
    expect(result.triaged.repoints).toEqual([]);
    expect(result.triaged.missing).toEqual([]);
    // Haiku should not be called
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("Haiku error in one batch does not block others", async () => {
    // Create enough dead links for 2 batches (>10)
    const links: string[] = [];
    for (let i = 0; i < 12; i++) {
      links.push(`[Entity${i}](../characters/entity${i}.md)`);
    }
    const content = "# Test\n" + links.join("\n");

    const fio = setupCampaign(
      {
        "/campaigns/test/characters/kael.md": content,
      },
      {
        "/campaigns/test/characters": ["kael.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    // First batch fails, second succeeds
    const error = new Error("API rate limit");
    const successResponse = JSON.stringify([
      { path: "characters/entity10.md", category: "stub", reason: "Mentioned once." },
      { path: "characters/entity11.md", category: "stub", reason: "Mentioned once." },
    ]);

    let callIdx = 0;
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => {
        if (callIdx++ === 0) throw error;
        return textResult(successResponse);
      }),
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    const result = await resolveDeadLinks(ROOT, fio, provider, "Check all");

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain("Triage failed");
    // Second batch should still have been processed
    expect(result.triaged.stubs.length).toBeGreaterThanOrEqual(1);
  });

  it("usage stats accumulate across triage + generation batches", async () => {
    const fio = setupCampaign(
      {
        "/campaigns/test/characters/kael.md": "# Kael\n[Tavern](../locations/tavern/index.md)",
      },
      {
        "/campaigns/test/characters": ["kael.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    const triageResponse = JSON.stringify([
      { path: "locations/tavern/index.md", category: "missing", reason: "Needed." },
    ]);
    const genResponse = "===locations/tavern/index.md===\n# Tavern\n**Type:** Location\n";
    const provider = mockProvider([textResult(triageResponse), textResult(genResponse)]);

    const result = await resolveDeadLinks(ROOT, fio, provider, "Generate", false);

    // Two API calls: triage + generation, each with 10 input + 5 output
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(10);
  });

  it("freeform context passed through to Haiku prompt", async () => {
    const fio = setupCampaign(
      {
        "/campaigns/test/characters/kael.md": "# Kael\n[Ghost](../characters/ghost.md)",
      },
      {
        "/campaigns/test/characters": ["kael.md"],
        "/campaigns/test/locations": [],
        "/campaigns/test/factions": [],
        "/campaigns/test/lore": [],
        "/campaigns/test/players": [],
      },
    );

    const triageResponse = JSON.stringify([
      { path: "characters/ghost.md", category: "stub", reason: "Minor mention." },
    ]);
    const provider = mockProvider([textResult(triageResponse)]);

    await resolveDeadLinks(ROOT, fio, provider, "I renamed ghost to specter");

    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The user message should contain the freeform context
    const userMsg = chatCall.messages[0].content;
    expect(userMsg).toContain("I renamed ghost to specter");
  });
});
