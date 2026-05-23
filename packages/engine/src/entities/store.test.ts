import { describe, it, expect, beforeEach } from "vitest";
import { EntityStore, EntityNotFoundError, EntityValidationError } from "./store.js";
import type { EntityFileIO } from "./store.js";
import { norm } from "../utils/paths.js";

// --- In-memory FileIO ---

/**
 * Stateful in-memory FileIO. Tracks file content keyed by normalized path.
 * Directory listings are derived from the file set, so a write under
 * `/root/locations/foo/index.md` makes `/root/locations` list `["foo"]` and
 * `/root/locations/foo` list `["index.md"]`.
 */
function inMemoryFileIO(initial: Record<string, string> = {}): EntityFileIO & { _files: Map<string, string> } {
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) files.set(norm(k), v);

  function dirOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx < 0 ? "" : path.slice(0, idx);
  }
  function nameOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx < 0 ? path : path.slice(idx + 1);
  }

  return {
    _files: files,
    async readFile(p) {
      const k = norm(p);
      const v = files.get(k);
      if (v === undefined) throw new Error(`ENOENT: ${k}`);
      return v;
    },
    async writeFile(p, content) { files.set(norm(p), content); },
    async mkdir() { /* directories are implicit */ },
    async exists(p) {
      const k = norm(p);
      if (files.has(k)) return true;
      // Treat as dir if any file path starts with `k/`
      for (const existing of files.keys()) {
        if (existing.startsWith(k + "/")) return true;
      }
      return false;
    },
    async listDir(p) {
      const k = norm(p);
      const seen = new Set<string>();
      for (const existing of files.keys()) {
        if (existing === k) continue;
        if (existing.startsWith(k + "/")) {
          const rest = existing.slice(k.length + 1);
          const slash = rest.indexOf("/");
          seen.add(slash === -1 ? rest : rest.slice(0, slash));
        }
      }
      if (seen.size === 0) {
        // Mirror real fs behavior: listDir on non-existent path throws.
        // Tests that target empty dirs should preload a placeholder.
        throw new Error(`ENOENT: ${k}`);
      }
      return [...seen];
    },
    async deleteFile(p) {
      const k = norm(p);
      if (!files.delete(k)) throw new Error(`ENOENT: ${k}`);
    },
    async rmdir(p) {
      const k = norm(p);
      for (const existing of files.keys()) {
        if (existing.startsWith(k + "/")) throw new Error(`ENOTEMPTY: ${k}`);
      }
    },
    // Suppress unused-helper lint when callers happen to not use them.
    ...{ _dirOf: dirOf, _nameOf: nameOf },
  } as EntityFileIO & { _files: Map<string, string> };
}

// --- Fixtures ---

const ROOT = "/root";

function character(name: string, body = "", extra: Record<string, string> = {}): string {
  const lines = [`# ${name}`, ""];
  lines.push(`**Type:** character`);
  for (const [k, v] of Object.entries(extra)) lines.push(`**${k}:** ${v}`);
  if (body) { lines.push("", body); }
  return lines.join("\n") + "\n";
}

function location(name: string, body = ""): string {
  const lines = [`# ${name}`, "", "**Type:** location"];
  if (body) { lines.push("", body); }
  return lines.join("\n") + "\n";
}

// --- Tests ---

describe("EntityStore path resolution", () => {
  it("resolves flat entity types to <dir>/<slug>.md", () => {
    const store = new EntityStore(ROOT, inMemoryFileIO());
    const p = store.pathFor("character", "Arvid the Pale");
    expect(p.rel).toBe("characters/arvid-the-pale.md");
    expect(p.abs).toBe("/root/characters/arvid-the-pale.md");
  });

  it("resolves locations to <dir>/<slug>/index.md", () => {
    const store = new EntityStore(ROOT, inMemoryFileIO());
    const p = store.pathFor("location", "The Crooked Coin");
    expect(p.rel).toBe("locations/crooked-coin/index.md");
  });

  it("is idempotent for already-slugified ids", () => {
    const store = new EntityStore(ROOT, inMemoryFileIO());
    expect(store.pathFor("character", "arvid-the-pale").rel)
      .toBe("characters/arvid-the-pale.md");
  });
});

describe("EntityStore CRUD roundtrip", () => {
  let io: ReturnType<typeof inMemoryFileIO>;
  let store: EntityStore;

  beforeEach(() => {
    io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid the Pale", "Retired soldier."),
    });
    store = new EntityStore(ROOT, io);
  });

  it("reads an existing character", async () => {
    const rec = await store.read("character", "arvid");
    expect(rec.displayName).toBe("Arvid the Pale");
    expect(rec.frontMatter.type).toBe("character");
    expect(rec.body).toContain("Retired soldier");
    expect(rec.schema.version).toBe("0.1");
  });

  it("throws EntityNotFoundError for missing entity", async () => {
    await expect(store.read("character", "ghost")).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it("creates a new character", async () => {
    const rec = await store.create("character", {
      displayName: "Mira",
      frontMatter: { disposition: "wary" },
      body: "Bardic scout.",
    });
    expect(rec.id).toBe("mira");
    expect(rec.frontMatter.disposition).toBe("wary");
    expect(rec.body).toContain("Bardic scout");
    expect(io._files.has("/root/characters/mira.md")).toBe(true);
  });

  it("refuses to create over an existing entity", async () => {
    // The seeded file's slug is `arvid`; a displayName that slugifies to the
    // same value must collide.
    await expect(store.create("character", { displayName: "Arvid" }))
      .rejects.toBeInstanceOf(EntityValidationError);
  });

  it("creates location at index.md path", async () => {
    const rec = await store.create("location", { displayName: "North Keep", body: "An old keep." });
    expect(rec.id).toBe("north-keep");
    expect(io._files.has("/root/locations/north-keep/index.md")).toBe(true);
  });

  it("updates frontmatter — null deletes a key", async () => {
    await store.update("character", "arvid", {
      frontMatter: { disposition: "grim", location: "[North Keep](../locations/north-keep/index.md)" },
    });
    const after = await store.read("character", "arvid");
    expect(after.frontMatter.disposition).toBe("grim");
    expect(after.frontMatter.location).toContain("North Keep");

    await store.update("character", "arvid", { frontMatter: { disposition: null } });
    const cleaned = await store.read("character", "arvid");
    expect(cleaned.frontMatter.disposition).toBeUndefined();
  });

  it("appends changelog entries with scene numbers", async () => {
    await store.update("character", "arvid", { changelogEntry: "Fled north", body: "Retired soldier." }, 7);
    const rec = await store.read("character", "arvid");
    expect(rec.changelog).toHaveLength(1);
    expect(rec.changelog[0]).toBe("**Scene 007**: Fled north");
  });

  it("preserves unknown frontmatter keys round-trip and flags them as drift", async () => {
    await store.update("character", "arvid", { frontMatter: { mood_today: "tense" } });
    const rec = await store.read("character", "arvid");
    expect(rec.frontMatter.mood_today).toBe("tense");
    expect(rec.drift.unknownFields).toContain("mood_today");
  });

  it("create/update preserves H1 display name on update without explicit displayName", async () => {
    await store.update("character", "arvid", { body: "Updated body" });
    const rec = await store.read("character", "arvid");
    expect(rec.displayName).toBe("Arvid the Pale");
  });
});

describe("EntityStore.delete + wikilink sweep", () => {
  it("deletes the file and surfaces inbound refs as dead", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid"),
      "/root/lore/fall-of-arvid.md":
        "# Fall of Arvid\n\n**Type:** lore\n\nWhen [Arvid](../characters/arvid.md) fell, the keep emptied.\n",
      "/root/characters/mira.md":
        "# Mira\n\n**Type:** character\n\nMira recalls [her old friend](../characters/arvid.md).\n",
    });
    const store = new EntityStore(ROOT, io);

    const del = await store.delete("character", "arvid");
    expect(del.path).toBe("characters/arvid.md");
    expect(del.deadReferences).toHaveLength(2);
    const files = del.deadReferences.map(r => r.file).sort();
    expect(files).toEqual(["characters/mira.md", "lore/fall-of-arvid.md"]);
    expect(io._files.has("/root/characters/arvid.md")).toBe(false);
  });

  it("deletes location subdir entry and reports it gone", async () => {
    const io = inMemoryFileIO({
      "/root/locations/north-keep/index.md": location("North Keep"),
    });
    const store = new EntityStore(ROOT, io);
    const del = await store.delete("location", "north-keep");
    expect(del.path).toBe("locations/north-keep/index.md");
    expect(io._files.has("/root/locations/north-keep/index.md")).toBe(false);
  });

  it("refuses to delete missing entity", async () => {
    const io = inMemoryFileIO();
    const store = new EntityStore(ROOT, io);
    await expect(store.delete("character", "ghost")).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});

describe("EntityStore index + list", () => {
  it("scans all entity types and reports their slugs", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid"),
      "/root/characters/mira.md": character("Mira"),
      "/root/factions/red-hand.md": "# Red Hand\n\n**Type:** faction\n",
      "/root/locations/north-keep/index.md": location("North Keep"),
      "/root/lore/fall.md": "# The Fall\n\n**Type:** lore\n",
      "/root/items/cursed-blade.md": "# Cursed Blade\n\n**Type:** item\n",
    });
    const store = new EntityStore(ROOT, io);
    const tree = await store.scanIndex();
    expect(Object.keys(tree).sort()).toEqual([
      "arvid", "cursed-blade", "fall", "mira", "north-keep", "red-hand",
    ]);
    expect(tree["north-keep"].type).toBe("location");
    expect(tree["north-keep"].path).toBe("locations/north-keep/index.md");
  });

  it("lists entities of a single type", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid the Pale", "", { "Additional Names": "Pale One, Pale" }),
      "/root/characters/mira.md": character("Mira"),
    });
    const store = new EntityStore(ROOT, io);
    const list = await store.list("character");
    expect(list).toHaveLength(2);
    const arvid = list.find(e => e.id === "arvid");
    expect(arvid?.displayName).toBe("Arvid the Pale");
    expect(arvid?.aliases).toEqual(["Pale One", "Pale"]);
  });

  it("skips conventional non-entity files (party.md, notes.md)", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid"),
      "/root/characters/party.md": "# The Party\nList of PCs.\n",
      "/root/characters/notes.md": "# Notes\n",
    });
    const store = new EntityStore(ROOT, io);
    const list = await store.list("character");
    expect(list.map(e => e.id)).toEqual(["arvid"]);
  });
});

describe("EntityStore observed-field scanner", () => {
  it("tallies frontmatter keys across all entities of a type", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid", "", { Disposition: "grim", "Mood Today": "tense" }),
      "/root/characters/mira.md":  character("Mira",  "", { Disposition: "wry", "Mood Today": "merry" }),
      "/root/characters/thane.md": character("Thane", "", { "Mood Today": "stoic" }),
    });
    const store = new EntityStore(ROOT, io);
    const observed = await store.scanObservedFields("character");
    expect(observed.mood_today.occursIn).toBe(3);
    expect(observed.mood_today.examples.sort()).toEqual(["arvid", "mira", "thane"]);
    expect(observed.disposition.occursIn).toBe(2);
    // declared key (type) shows up too
    expect(observed.type.occursIn).toBe(3);
  });

  it("scans all types in one call", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid"),
      "/root/factions/red-hand.md": "# Red Hand\n\n**Type:** faction\n**Stance:** hostile\n",
    });
    const store = new EntityStore(ROOT, io);
    const all = await store.scanAllObservedFields();
    expect(all.character.type.occursIn).toBe(1);
    expect(all.faction.stance.occursIn).toBe(1);
    expect(all.lore).toEqual({});
  });
});

describe("EntityStore.read references", () => {
  it("classifies outbound links as resolved or dead", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md":
        "# Arvid\n\n**Type:** character\n\nMember of [Red Hand](../factions/red-hand.md). Knows of [Ghost Hand](../factions/ghost-hand.md).\n",
      "/root/factions/red-hand.md": "# Red Hand\n\n**Type:** faction\n",
    });
    const store = new EntityStore(ROOT, io);
    const rec = await store.read("character", "arvid");
    expect(rec.references.outbound).toContain("faction:red-hand");
    expect(rec.references.dead).toContain("factions/ghost-hand.md");
  });

  it("collects inbound references from other entities", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid"),
      "/root/lore/fall-of-arvid.md":
        "# Fall of Arvid\n\n**Type:** lore\n\n[Arvid](../characters/arvid.md) fell.\n",
    });
    const store = new EntityStore(ROOT, io);
    const rec = await store.read("character", "arvid");
    expect(rec.references.inbound).toContain("lore:fall-of-arvid");
  });

  it("flags dead outbound refs in validation warnings", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md":
        "# Arvid\n\n**Type:** character\n\nFollows [Dead Faction](../factions/dead.md).\n",
    });
    const store = new EntityStore(ROOT, io);
    const rec = await store.read("character", "arvid");
    expect(rec.validation.status).toBe("warnings");
    expect(rec.validation.issues.some(i => i.msg.includes("does not resolve"))).toBe(true);
  });
});

describe("EntityStore.detectOrphans", () => {
  it("returns entities with no inbound references", async () => {
    const io = inMemoryFileIO({
      "/root/characters/arvid.md": character("Arvid"),
      "/root/characters/mira.md":
        "# Mira\n\n**Type:** character\n\nKnows [Arvid](../characters/arvid.md).\n",
      "/root/lore/orphan.md": "# Orphan Lore\n\n**Type:** lore\n",
    });
    const store = new EntityStore(ROOT, io);
    const orphans = await store.detectOrphans();
    const ids = orphans.map(o => o.id).sort();
    expect(ids).toEqual(["mira", "orphan"]);
  });
});
