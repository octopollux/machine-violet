import { describe, it, expect, beforeEach } from "vitest";
import { EntityStore, type EntityFileIO } from "./store.js";
import { buildEntityToolHandler } from "./tools.js";
import { norm } from "../utils/paths.js";

// --- In-memory FileIO (same shape as store.test.ts) ---

function inMemoryFileIO(initial: Record<string, string> = {}): EntityFileIO & { _files: Map<string, string> } {
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) files.set(norm(k), v);
  return {
    _files: files,
    async readFile(p) {
      const v = files.get(norm(p));
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async writeFile(p, content) { files.set(norm(p), content); },
    async mkdir() { /* implicit */ },
    async exists(p) {
      const k = norm(p);
      if (files.has(k)) return true;
      for (const existing of files.keys()) {
        if (existing.startsWith(k + "/")) return true;
      }
      return false;
    },
    async listDir(p) {
      const k = norm(p);
      const seen = new Set<string>();
      for (const existing of files.keys()) {
        if (existing.startsWith(k + "/")) {
          const rest = existing.slice(k.length + 1);
          const slash = rest.indexOf("/");
          seen.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }
      if (seen.size === 0) throw new Error(`ENOENT: ${k}`);
      return [...seen];
    },
    async deleteFile(p) {
      const k = norm(p);
      if (!files.delete(k)) throw new Error(`ENOENT: ${k}`);
    },
    async rmdir() { /* ok */ },
  };
}

const ROOT = "/root";

function makeStore(initial: Record<string, string> = {}): {
  store: EntityStore;
  io: ReturnType<typeof inMemoryFileIO>;
  handler: ReturnType<typeof buildEntityToolHandler>;
} {
  const io = inMemoryFileIO(initial);
  const store = new EntityStore(ROOT, io);
  const handler = buildEntityToolHandler(store, { sceneNumber: 3 });
  return { store, io, handler };
}

// --- Tests ---

describe("entity tool — CRUD facade", () => {
  let stuff: ReturnType<typeof makeStore>;

  beforeEach(() => {
    stuff = makeStore({
      "/root/characters/arvid.md": "# Arvid\n\n**Type:** character\n\nA grim soldier.\n",
    });
  });

  it("returns null for unknown tool names", async () => {
    const out = await stuff.handler("not_a_tool", {});
    expect(out).toBeNull();
  });

  it("read returns the rich record", async () => {
    const out = await stuff.handler("entity", { op: "read", type: "character", id: "arvid" });
    expect(out?.is_error).toBeUndefined();
    const parsed = JSON.parse(out!.content);
    expect(parsed.displayName).toBe("Arvid");
    expect(parsed.schema.knownFields).toContain("displayName");
    expect(parsed.references.outbound).toEqual([]);
  });

  it("read surfaces EntityNotFoundError as is_error", async () => {
    const out = await stuff.handler("entity", { op: "read", type: "character", id: "ghost" });
    expect(out?.is_error).toBe(true);
    expect(out?.content).toContain("Entity not found");
  });

  it("create writes a new entity and returns the record", async () => {
    const out = await stuff.handler("entity", {
      op: "create",
      type: "lore",
      patch: { displayName: "Fall of Arvid", body: "It happened long ago." },
    });
    expect(out?.is_error).toBeUndefined();
    const parsed = JSON.parse(out!.content);
    expect(parsed.id).toBe("fall-of-arvid");
    expect(stuff.io._files.has("/root/lore/fall-of-arvid.md")).toBe(true);
  });

  it("create errors when displayName is missing", async () => {
    const out = await stuff.handler("entity", { op: "create", type: "lore", patch: {} });
    expect(out?.is_error).toBe(true);
  });

  it("update merges patch and writes scene-numbered changelog", async () => {
    const out = await stuff.handler("entity", {
      op: "update",
      type: "character",
      id: "arvid",
      patch: { frontMatter: { disposition: "wary" }, changelogEntry: "Lost his sword" },
    });
    expect(out?.is_error).toBeUndefined();
    const parsed = JSON.parse(out!.content);
    expect(parsed.frontMatter.disposition).toBe("wary");
    expect(parsed.changelog[0]).toBe("**Scene 003**: Lost his sword");
  });

  it("delete reports inbound dead refs", async () => {
    stuff = makeStore({
      "/root/characters/arvid.md": "# Arvid\n\n**Type:** character\n",
      "/root/lore/echoes.md": "# Echoes\n\n**Type:** lore\n\n[Arvid](../characters/arvid.md) walked here.\n",
    });
    const out = await stuff.handler("entity", { op: "delete", type: "character", id: "arvid" });
    expect(out?.is_error).toBeUndefined();
    const parsed = JSON.parse(out!.content);
    expect(parsed.deadReferences).toHaveLength(1);
    expect(parsed.deadReferences[0].file).toBe("lore/echoes.md");
  });

  it("list returns all entities of a type", async () => {
    stuff = makeStore({
      "/root/characters/arvid.md": "# Arvid\n\n**Type:** character\n",
      "/root/characters/mira.md": "# Mira\n\n**Type:** character\n",
    });
    const out = await stuff.handler("entity", { op: "list", type: "character" });
    const parsed = JSON.parse(out!.content);
    expect(parsed.map((e: { id: string }) => e.id).sort()).toEqual(["arvid", "mira"]);
  });

  it("rejects unknown op", async () => {
    const out = await stuff.handler("entity", { op: "drop", type: "character", id: "arvid" });
    expect(out?.is_error).toBe(true);
  });

  it("rejects unknown type", async () => {
    const out = await stuff.handler("entity", { op: "read", type: "spaceship", id: "x" });
    expect(out?.is_error).toBe(true);
  });
});

describe("describe_entity_type tool", () => {
  it("merges declared schema with observed drift", async () => {
    const { handler } = makeStore({
      "/root/characters/arvid.md":
        "# Arvid\n\n**Type:** character\n**Mood Today:** tense\n",
      "/root/characters/mira.md":
        "# Mira\n\n**Type:** character\n**Mood Today:** merry\n",
    });
    const out = await handler("describe_entity_type", { type: "character" });
    const parsed = JSON.parse(out!.content);
    expect(parsed.fields.displayName).toBeDefined();
    expect(parsed.observedDrift.mood_today.occursIn).toBe(2);
    // Declared `type` field should not show up as drift
    expect(parsed.observedDrift.type).toBeUndefined();
    expect(parsed.examples).toContain("characters/arvid.md");
  });
});

describe("list_entity_types tool", () => {
  it("returns counts per type", async () => {
    const { handler } = makeStore({
      "/root/characters/arvid.md": "# Arvid\n\n**Type:** character\n",
      "/root/factions/red-hand.md": "# Red Hand\n\n**Type:** faction\n",
      "/root/factions/black-rose.md": "# Black Rose\n\n**Type:** faction\n",
    });
    const out = await handler("list_entity_types", {});
    const parsed = JSON.parse(out!.content) as { type: string; count: number }[];
    const byType = Object.fromEntries(parsed.map(p => [p.type, p.count]));
    expect(byType.character).toBe(1);
    expect(byType.faction).toBe(2);
    expect(byType.lore).toBe(0);
  });
});

describe("validate_entity tool", () => {
  it("flags dead outbound refs as warnings", async () => {
    const { handler } = makeStore({
      "/root/characters/arvid.md":
        "# Arvid\n\n**Type:** character\n\nKnows [Gone](../characters/gone.md).\n",
    });
    const out = await handler("validate_entity", { type: "character", id: "arvid" });
    const parsed = JSON.parse(out!.content);
    expect(parsed.validation.status).toBe("warnings");
    expect(parsed.validation.issues.some((i: { msg: string }) => i.msg.includes("does not resolve"))).toBe(true);
  });

  it("succeeds on a clean entity", async () => {
    const { handler } = makeStore({
      "/root/characters/arvid.md": "# Arvid\n\n**Type:** character\n",
    });
    const out = await handler("validate_entity", { type: "character", id: "arvid" });
    const parsed = JSON.parse(out!.content);
    expect(parsed.validation.status).toBe("ok");
  });
});

describe("find_schema_drift tool", () => {
  it("returns drift keyed by type when no type given", async () => {
    const { handler } = makeStore({
      "/root/characters/arvid.md":
        "# Arvid\n\n**Type:** character\n**Mood Today:** tense\n",
      "/root/factions/red-hand.md":
        "# Red Hand\n\n**Type:** faction\n**Stance:** hostile\n",
    });
    const out = await handler("find_schema_drift", {});
    const parsed = JSON.parse(out!.content);
    expect(parsed.character.mood_today.occursIn).toBe(1);
    expect(parsed.faction.stance.occursIn).toBe(1);
    expect(parsed.lore).toEqual({});
  });

  it("scopes to a single type when given", async () => {
    const { handler } = makeStore({
      "/root/characters/arvid.md":
        "# Arvid\n\n**Type:** character\n**Mood Today:** tense\n",
      "/root/factions/red-hand.md":
        "# Red Hand\n\n**Type:** faction\n**Stance:** hostile\n",
    });
    const out = await handler("find_schema_drift", { type: "character" });
    const parsed = JSON.parse(out!.content);
    expect(parsed.character.mood_today.occursIn).toBe(1);
    expect(parsed.faction).toBeUndefined();
  });
});

describe("detect_orphans tool", () => {
  it("lists entities with no inbound refs", async () => {
    const { handler } = makeStore({
      "/root/characters/arvid.md": "# Arvid\n\n**Type:** character\n",
      "/root/characters/mira.md":
        "# Mira\n\n**Type:** character\n\nKnows [Arvid](../characters/arvid.md).\n",
      "/root/lore/orphan.md": "# Orphan Lore\n\n**Type:** lore\n",
    });
    const out = await handler("detect_orphans", {});
    const parsed = JSON.parse(out!.content) as { id: string }[];
    expect(parsed.map(o => o.id).sort()).toEqual(["mira", "orphan"]);
  });
});
