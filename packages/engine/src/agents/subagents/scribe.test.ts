import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildScribeToolHandler, splitSections, mergeSectionBodies, sanitizeFrontMatter, buildPrefetchedEntityBlock, runScribe } from "./scribe.js";
import type { ScribeFileIO } from "./scribe.js";
import { getCampaignKnowledge } from "../../knowledge/store.js";
import type { LLMProvider, ChatResult } from "../../providers/types.js";
import { loadModelConfig } from "../../config/models.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import { norm } from "../../utils/paths.js";

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetPromptCache();
});

function mockFileIO(files: Record<string, string> = {}): ScribeFileIO {
  // Normalize all keys on construction for cross-platform compat
  const store: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) store[norm(k)] = v;
  return {
    readFile: vi.fn(async (path: string) => {
      const p = norm(path);
      if (store[p]) return store[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      store[norm(path)] = content;
    }),
    exists: vi.fn(async (path: string) => norm(path) in store),
    listDir: vi.fn(async (path: string) => {
      const prefix = norm(path.endsWith("/") ? path : path + "/");
      const entries = new Set<string>();
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const first = rest.split("/")[0];
          entries.add(first);
        }
      }
      if (entries.size === 0) throw new Error("ENOENT");
      return [...entries];
    }),
    mkdir: vi.fn(async () => {}),
    deleteFile: vi.fn(async (path: string) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete store[norm(path)];
    }),
    rmdir: vi.fn(async (path: string) => {
      // Reject if any keys still live under this directory.
      const prefix = norm(path) + "/";
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) throw new Error("ENOTEMPTY");
      }
    }),
  };
}

describe("scribe committed memory", () => {
  it("resolves a short alias through the store and preserves unrelated values", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/camp", io);
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Bob", aliases: ["B"], fields: { hp: 9, promise: "Return" } }]);
    const updates: string[] = [];
    const handler = buildScribeToolHandler(io, "/camp", 2, [], updates, []);
    const result = await handler("remember", { operations: [{ op: "upsert", collection: "Characters", name: "B", fields: { hp: 8 }, history: "Injured" }] });
    expect(result.is_error).toBeUndefined(); expect(updates).toContain(await store.resolve("Bob"));
    expect((await store.read("Bob")).fields).toMatchObject({ hp: 8, promise: "Return" });
  });

  it("fresh scribes receive latest empty nested collections, bounded records, and unchanged tools", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/camp", io);
    await store.mutate([{ op: "create_collection", name: "Spells", note: "Named spells; reference practitioners" }, { op: "create_collection", parent: "Spells", name: "Arcane" }, { op: "upsert", collection: "Characters", name: "Bob", body: "q".repeat(30000), fields: { hp: 9 } }]);
    const response: ChatResult = { text: "Done", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 }, stopReason: "end", assistantContent: [{ type: "text", text: "Done" }] };
    const provider = { providerId: "test", chat: vi.fn(async () => response), healthCheck: vi.fn() } as unknown as LLMProvider;
    await runScribe(provider, { updates: [{ visibility: "player-facing", content: "Bob learned Firefly" }], campaignRoot: "/camp", sceneNumber: 1, homeDir: "/home" }, io, "claude-haiku-4-5-20251001");
    const first = vi.mocked(provider.chat).mock.calls[0][0];
    const text = JSON.stringify(first.messages);
    expect(text).toContain("Spells"); expect(text).toContain("Arcane"); expect(text).toContain("Named spells; reference practitioners");
    expect(text.length).toBeLessThan(12000); expect(text).not.toContain('"kind":"value"');
    await store.mutate([{ op: "create_collection", name: "Promises" }]);
    await runScribe(provider, { updates: [{ visibility: "private", content: "Bob promised to return" }], campaignRoot: "/camp", sceneNumber: 1, homeDir: "/home" }, io, "claude-haiku-4-5-20251001");
    const second = vi.mocked(provider.chat).mock.calls[1][0];
    expect(JSON.stringify(second.messages)).toContain("Promises"); expect(second.tools).toEqual(first.tools);
  });

  it("dispatches narrative recall through remember and returns canonical notices independently of prose", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/camp", io);
    await store.mutate([{ op: "create_collection", name: "Spells" }, { op: "create_collection", parent: "Spells", name: "Arcane" }, { op: "upsert", collection: "Characters", name: "Bob", aliases: ["B"] }]);
    await store.acknowledgeNotices((await store.pendingNotices()).map((notice) => notice.id));
    const bob = await store.resolve("Bob");
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
    const input = { operations: [{ op: "upsert", collection: "Spells/Arcane", name: "Firefly", fields: { practitioner: { $ref: "B" }, level: 1 }, history: "Bob learned Firefly" }] };
    const responses: ChatResult[] = [
      { text: "", toolCalls: [{ id: "recall", name: "remember", input }], usage, stopReason: "tool_use", assistantContent: [{ type: "tool_use", id: "recall", name: "remember", input }] },
      { text: "Recorded the new spell.", toolCalls: [], usage, stopReason: "end", assistantContent: [{ type: "text", text: "Recorded the new spell." }] },
    ];
    const provider = { providerId: "test", chat: vi.fn(async () => responses.shift()), healthCheck: vi.fn() } as unknown as LLMProvider;
    const result = await runScribe(provider, { updates: [{ visibility: "private", content: "B learned Firefly" }], campaignRoot: "/camp", sceneNumber: 3, homeDir: "/home" }, io, "claude-haiku-4-5-20251001");
    const spell = await store.read("Firefly");
    expect(spell.fields).toMatchObject({ practitioner: { $ref: bob }, level: 1 });
    expect(result.updated).toContain(spell.uid); expect(result.summary).not.toContain(spell.uid);
    expect(await store.pendingNotices()).toEqual([expect.objectContaining({ source: "scribe", identities: expect.arrayContaining([expect.objectContaining({ uid: spell.uid, name: "Firefly" })]) })]);
    const toolResults = JSON.stringify(vi.mocked(provider.chat).mock.calls[1][0].messages);
    expect(toolResults).toContain(spell.uid); expect(io.writeFile).not.toHaveBeenCalled();
  });

  it("canonical prefetch remains bounded and recognizes one-letter aliases", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/camp", io);
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Bob", aliases: ["B"], body: "x".repeat(20000) }]);
    const block = await buildPrefetchedEntityBlock([{ visibility: "private", content: "B arrived" }], undefined, "/camp", io);
    expect(block).toContain("Canonical committed"); expect(block).toContain("Bob"); expect(block.length).toBeLessThan(12000);
  });

  it("appends machine profile boundaries without creating campaign nodes", async () => {
    const io = mockFileIO({ "/home/players/alice.md": "# Alice\n\n**Type:** player\n\n## Content Boundaries\n- No spiders\n" });
    const handler = buildScribeToolHandler(io, "/camp", 2, [], [], [], [], "/home");
    const result = await handler("player_profile", { action: "append", player: "Alice", section: "Content Boundaries", text: "No drowning" });
    expect(result.is_error).toBeUndefined();
    const profile = await io.readFile("/home/players/alice.md"); expect(profile).toContain("No spiders"); expect(profile).toContain("No drowning");
    expect(await (await getCampaignKnowledge("/camp", io)).resolve("Alice")).toBeNull();
    const bad = await handler("player_profile", { action: "replace", player: "Alice", text: "Clear" }); expect(bad.is_error).toBe(true);
  });
});
describe("splitSections", () => {
  it("returns single entry for body with no headings", () => {
    const result = splitSections("Just plain text.\n\nAnother paragraph.");
    expect(result).toHaveLength(1);
    expect(result[0].heading).toBe("");
    expect(result[0].content).toContain("Just plain text.");
  });

  it("splits on ## headings", () => {
    const body = "Preamble.\n\n## Stats\nHP: 42\n\n## Inventory\n- Sword";
    const result = splitSections(body);
    expect(result).toHaveLength(3);
    expect(result[0].heading).toBe("");
    // Trailing blank line (the separator before ## Stats) is stripped from content.
    expect(result[0].content).toBe("Preamble.");
    expect(result[1].heading).toBe("## Stats");
    expect(result[1].content).toBe("## Stats\nHP: 42");
    expect(result[2].heading).toBe("## Inventory");
  });

  it("strips trailing blank lines from section content (no separator baked in)", () => {
    const body = "## Stats\nHP: 42\n\n\n## Inventory\n- Sword\n\n";
    const result = splitSections(body);
    expect(result[0].content).toBe("## Stats\nHP: 42");
    expect(result[1].content).toBe("## Inventory\n- Sword");
  });

  it("preserves meaningful trailing whitespace on a content line (markdown hard break)", () => {
    // The two trailing spaces on "first line" are a hard break — keep them;
    // only the trailing blank lines get stripped.
    const result = splitSections("## Notes\nfirst line  \nsecond line\n\n\n");
    expect(result[0].content).toBe("## Notes\nfirst line  \nsecond line");
  });

  it("does not split on ### headings", () => {
    const body = "## Stats\nHP: 42\n### Substats\nSTR: 10";
    const result = splitSections(body);
    expect(result).toHaveLength(1);
    expect(result[0].heading).toBe("## Stats");
    expect(result[0].content).toContain("### Substats");
  });
});

describe("mergeSectionBodies", () => {
  it("appends plain text (no headings) for backward compat", () => {
    const result = mergeSectionBodies("Existing text.", "New text.");
    expect(result).toBe("Existing text.\n\nNew text.");
  });

  it("replaces matching section in-place", () => {
    const existing = "## Inventory\n- Sword\n\n## Notes\nBrave.";
    const incoming = "## Inventory\n- Sword\n- Dagger";
    const result = mergeSectionBodies(existing, incoming);
    expect((result.match(/## Inventory/g) || []).length).toBe(1);
    expect(result).toContain("Dagger");
    expect(result).toContain("## Notes");
    expect(result).toContain("Brave.");
  });

  it("does not accumulate blank lines across repeated merges (regression)", () => {
    let body = "## Stats\nHP: 3/3\n\n## Skills\n- Salvage `d8`\n\n## Inventory\n- Tool belt";
    const once = mergeSectionBodies(body, "## Inventory\n- Tool belt\n- Wrench");
    // Re-merging the same incoming must be a fixed point — no growing gaps.
    const twice = mergeSectionBodies(once, "## Inventory\n- Tool belt\n- Wrench");
    expect(twice).toBe(once);
    // Even after many section-touching writes, no blank-line run (3+ newlines) appears.
    for (let i = 0; i < 6; i++) body = mergeSectionBodies(body, "## Stats\nHP: 2/3");
    expect(body).not.toMatch(/\n\n\n/);
  });

  it("does not create a blank-line run joining a preamble-only body with a section", () => {
    // `existing` has no ## heading and ends in a blank line — the early-return
    // split path must strip it so the join can't produce \n\n\n.
    const result = mergeSectionBodies("A brave knight.\n", "## Inventory\n- Sword");
    expect(result).toBe("A brave knight.\n\n## Inventory\n- Sword");
    expect(result).not.toMatch(/\n\n\n/);
  });

  it("preserves preamble text before first heading", () => {
    const existing = "A brave knight.\n\n## Inventory\n- Sword";
    const incoming = "## Inventory\n- Sword\n- Shield";
    const result = mergeSectionBodies(existing, incoming);
    expect(result).toContain("A brave knight.");
    expect(result).toContain("Shield");
    expect((result.match(/## Inventory/g) || []).length).toBe(1);
  });

  it("does not overwrite preamble with incoming preamble", () => {
    const existing = "Original description.\n\n## Stats\nHP: 42";
    const incoming = "## Stats\nHP: 30";
    const result = mergeSectionBodies(existing, incoming);
    expect(result).toContain("Original description.");
  });

  it("appends incoming body that only has ### headings (no ## sections)", () => {
    const existing = "## Stats\nHP: 42";
    const incoming = "### Substats\nSTR: 10";
    const result = mergeSectionBodies(existing, incoming);
    expect(result).toContain("## Stats");
    expect(result).toContain("### Substats");
    expect(result).toContain("STR: 10");
  });
});

describe("sanitizeFrontMatter", () => {
  // These cases all came from route-0 (gpt-5.4-mini scribe). Without the
  // sanitizer they round-trip as `****Type:** character:** character` etc.
  // and the file frontmatter is permanently corrupted.
  it("passes well-formed keys through unchanged", () => {
    const input = {
      type: "character",
      disposition: "friendly",
      location: "[[The Shattered Hall]]",
    };
    expect(sanitizeFrontMatter(input)).toEqual(input);
  });

  it("recovers when the whole `**Key:** Value` line is the JSON key", () => {
    const out = sanitizeFrontMatter({ "**Type:** character": "character" });
    expect(out).toEqual({ type: "character" });
  });

  it("recovers when the value differs from the key fragment (prefers explicit value)", () => {
    // Model sometimes passes the new value separately while still
    // malforming the key — the explicit value should win.
    const out = sanitizeFrontMatter({ "**Disposition:** old": "new" });
    expect(out).toEqual({ disposition: "new" });
  });

  it("handles multiple malformed keys without dropping any", () => {
    const out = sanitizeFrontMatter({
      "**Type:** NPC": "NPC",
      "**Location:** [[US-9]]": "[[US-9]]",
    });
    expect(out).toEqual({ type: "NPC", location: "[[US-9]]" });
  });

  it("lowercases and snake-cases recovered keys to match normalizeKey", () => {
    const out = sanitizeFrontMatter({ "**Additional Names:** Foo, Bar": "Foo, Bar" });
    expect(out).toEqual({ additional_names: "Foo, Bar" });
  });

  it("does not clobber an already-clean key with a malformed duplicate", () => {
    // If both forms are present, the clean key arrives first in
    // Object.entries order; sanitizer must not overwrite it.
    const out = sanitizeFrontMatter({
      type: "character",
      "**Type:** NPC": "NPC",
    });
    expect(out).toEqual({ type: "character" });
  });

  it("preserves null sentinel for key deletion", () => {
    const out = sanitizeFrontMatter({ placeholder: null });
    expect(out).toEqual({ placeholder: null });
  });

  it("preserves null sentinel even when the malformed key carries an old value fragment", () => {
    // Regression for the case Copilot flagged on #481: a model that
    // means to delete a field but also malforms the key would silently
    // resurrect the old value because the recovered fragment looks like
    // information. `null` always means delete — never substitute.
    const out = sanitizeFrontMatter({ "**Location:** [[Old]]": null });
    expect(out).toEqual({ location: null });
  });
});
