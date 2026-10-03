import { materializeWorldContent, buildCampaignWorld } from "./world-builder.js";
import type { FileIO } from "./scene-manager.js";
import type { SetupResult } from "./setup-agent.js";
import type { WorldFile } from "@machine-violet/shared/types/world.js";
import { norm } from "../utils/paths.js";
import { getCampaignKnowledge } from "../knowledge/store.js";

/** In-memory FileIO keyed by normalized path. Records writes + mkdirs. */
function mockFileIO(): { io: FileIO; store: Record<string, string>; dirs: Set<string> } {
  const store: Record<string, string> = {};
  const dirs = new Set<string>();
  const io: FileIO = {
    readFile: async (p) => {
      const v = store[norm(p)];
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: async (p, content) => { store[norm(p)] = content; },
    appendFile: async (p, content) => { store[norm(p)] = (store[norm(p)] ?? "") + content; },
    mkdir: async (p) => { dirs.add(norm(p)); },
    exists: async (p) => norm(p) in store,
    listDir: async () => [],
  };
  return { io, store, dirs };
}

/** Helper: keys of the store, normalized, for membership checks. */
function paths(store: Record<string, string>): string[] {
  return Object.keys(store);
}

const ROOT = "/camp/three-histories";

function richWorld(overrides: Partial<WorldFile> = {}): WorldFile {
  return {
    format: "machine-violet-world",
    version: 1,
    name: "Three Histories",
    summary: "A city built on ruins.",
    genres: ["fantasy"],
    entities: {
      characters: {
        "vesper-caine": {
          title: "Vesper Caine",
          frontMatter: { type: "NPC", disposition: "neutral" },
          body: "A cartographer who reads the old quarter.",
        },
        // A PC-typed entity must be skipped — the live PC comes from chargen.
        "old-hero": {
          title: "Old Hero",
          frontMatter: { type: "PC" },
          body: "The previous campaign's protagonist — should not be written.",
        },
      },
      locations: {
        "the-arcade": {
          title: "The Arcade",
          frontMatter: { type: "Location", theme: "gothic" },
          body: "A converted temple lined with reading desks.",
        },
      },
      factions: {
        "reformist-council": {
          title: "Reformist Council",
          frontMatter: { type: "Faction" },
          body: "Wants to build something new.",
        },
      },
      lore: {
        "the-cascade": {
          title: "The Cascade",
          frontMatter: { type: "Lore" },
          body: "The collapse no one fully remembers.",
        },
      },
      items: {
        "the-cipher-disc": {
          title: "The Cipher Disc",
          frontMatter: { type: "Item" },
          body: "Decodes the oldest fragments.",
        },
      },
    },
    rules: {
      "house-rules": "<system name=\"House\">\n<core_mechanic>Roll high.</core_mechanic>\n</system>\n",
    },
    maps: {
      "arcade-floor": { id: "arcade-floor", gridType: "square", bounds: { width: 10, height: 10 } },
    },
    calendar: {
      current: 14400,
      epoch: "The founding of the city",
      display_format: "fantasy",
    },
    ...overrides,
  };
}

describe("materializeWorldContent", () => {
  it("writes NPC characters but skips PC-typed seed entities", async () => {
    const { io, store } = mockFileIO();
    await materializeWorldContent(ROOT, richWorld(), io);

    const knowledge=await getCampaignKnowledge(ROOT,io);
    expect((await knowledge.read("Vesper Caine")).body).toContain("A cartographer");
    expect(await knowledge.resolve("Old Hero")).toBeNull();
    expect(paths(store).some(p=>p.includes("characters/"))).toBe(false);
  });

  it("materializes locations, factions, lore and items into their default collections", async()=>{
    const {io}=mockFileIO();await materializeWorldContent(ROOT,richWorld(),io);
    const knowledge=await getCampaignKnowledge(ROOT,io);
    for(const name of ["The Arcade","Reformist Council","The Cascade","The Cipher Disc"]) expect(await knowledge.resolve(name)).not.toBeNull();
    expect((await knowledge.read("The Arcade")).fields.theme).toBe("gothic");
  });

  it("writes rule cards verbatim to rules/", async () => {
    const { io, store } = mockFileIO();
    await materializeWorldContent(ROOT, richWorld(), io);

    const ruleContent = store[norm(`${ROOT}/rules/house-rules.md`)];
    expect(ruleContent).toBe("<system name=\"House\">\n<core_mechanic>Roll high.</core_mechanic>\n</system>\n");
  });

  it("seeds state/maps.json from the world maps", async () => {
    const { io, store } = mockFileIO();
    await materializeWorldContent(ROOT, richWorld(), io);

    const maps = JSON.parse(store[norm(`${ROOT}/state/maps.json`)]);
    expect(maps["arcade-floor"]).toMatchObject({ id: "arcade-floor", gridType: "square" });
  });

  it("seeds state/clocks.json from the world calendar with idle clocks and no alarms", async () => {
    const { io, store } = mockFileIO();
    await materializeWorldContent(ROOT, richWorld(), io);

    const clocks = JSON.parse(store[norm(`${ROOT}/state/clocks.json`)]);
    expect(clocks.calendar).toMatchObject({
      current: 14400,
      epoch: "The founding of the city",
      display_format: "fantasy",
      alarms: [],
    });
    expect(clocks.combat).toMatchObject({ current: 0, active: false, alarms: [] });
  });

  it("never seeds the player-facing compendium or a PC sheet", async () => {
    const { io, store } = mockFileIO();
    await materializeWorldContent(ROOT, richWorld(), io);

    expect(paths(store)).not.toContain(norm(`${ROOT}/campaign/compendium.json`));
    // No campaign log entries are written by materialization either.
    expect(paths(store)).not.toContain(norm(`${ROOT}/campaign/log.json`));
  });

  it("materializes a fork-scoped entity only when its branch is selected", async () => {
    const scoped: WorldFile = {
      ...richWorld(),
      entities: {
        characters: {
          "data-archivist": {
            title: "Data Archivist",
            frontMatter: { type: "NPC" },
            body: "Tends the server farm.",
            appliesWhen: { fork: "wrapper", option: "scifi" },
          },
          "temple-scribe": {
            title: "Temple Scribe",
            frontMatter: { type: "NPC" },
            body: "Tends the oil lamps.",
            appliesWhen: { fork: "wrapper", option: "fantasy" },
          },
          "always-here": {
            title: "Always Here",
            frontMatter: { type: "NPC" },
            body: "Universal NPC.",
          },
        },
      },
    };

    // Sci-fi branch selected → only the scifi-scoped + universal NPCs.
    const a = mockFileIO();
    await materializeWorldContent(ROOT, scoped, a.io, { wrapper: "scifi" });
    expect(await (await getCampaignKnowledge(ROOT,a.io)).resolve("Data Archivist")).not.toBeNull();
    expect(await (await getCampaignKnowledge(ROOT,a.io)).resolve("Always Here")).not.toBeNull();
    expect(await (await getCampaignKnowledge(ROOT,a.io)).resolve("Temple Scribe")).toBeNull();

    // No selection → scoped entities are withheld; universal still written.
    const b = mockFileIO();
    await materializeWorldContent(ROOT, scoped, b.io);
    expect(await (await getCampaignKnowledge(ROOT,b.io)).resolve("Always Here")).not.toBeNull();
    expect(await (await getCampaignKnowledge(ROOT,b.io)).resolve("Data Archivist")).toBeNull();
    expect(await (await getCampaignKnowledge(ROOT,b.io)).resolve("Temple Scribe")).toBeNull();
  });

  it("is a no-op-safe for a minimal seed with no inline content", async () => {
    const { io, store } = mockFileIO();
    const minimal: WorldFile = {
      format: "machine-violet-world",
      version: 1,
      name: "Hollowdeep",
      summary: "A mining town's deepest shaft broke into something old.",
      genres: ["fantasy", "horror"],
    };
    await materializeWorldContent(ROOT, minimal, io);
    expect(paths(store)).toHaveLength(0);
  });
});

/** Minimal SetupResult for buildCampaignWorld. */
function setupResult(overrides: Partial<SetupResult> = {}): SetupResult {
  return {
    genre: "fantasy",
    system: null,
    campaignName: "The Salt Wedding",
    campaignPremise: "A wedding, a feud, a missing bride.",
    campaignDetail: null,
    mood: "tense",
    difficulty: "balanced",
    personality: { name: "The Chronicler", prompt_fragment: "You are The Chronicler." },
    playerName: "Tester",
    characterName: "Wren",
    characterDescription: "An outsider drawn to the marsh.",
    characterDetails: null,
    themeColor: "#4488ff",
    ...overrides,
  };
}

describe("buildCampaignWorld rich import (wiring)", () => {
  it("materializes the bundled seed's inline content when worldSlug is set, alongside the chargen PC", async () => {
    const { io, store } = mockFileIO();
    // homeDir omitted → loadWorldBySlug falls through to the bundled worlds dir
    // (assetDir resolves to repo worlds/ in vitest). No userWorldsDir needed.
    const root = await buildCampaignWorld("/camp", setupResult({ worldSlug: "the-salt-wedding" }), io);

    // The live PC from chargen.
    expect(await (await getCampaignKnowledge(root,io)).resolve("Wren")).not.toBeNull();
    // Seeded NPCs materialized from the world file.
    expect(await (await getCampaignKnowledge(root,io)).resolve("Maren Holt")).not.toBeNull();
    expect(await (await getCampaignKnowledge(root,io)).resolve("Dunmore Vane")).not.toBeNull();
    // Seeded location, faction, lore, item.
    expect(await (await getCampaignKnowledge(root,io)).resolve("The Tideward Hall")).not.toBeNull();
    const seededKnowledge = await getCampaignKnowledge(root, io);
    expect(await seededKnowledge.resolve("The Hall")).toBe(await seededKnowledge.resolve("The Tideward Hall"));
    expect((await seededKnowledge.read("Maren Holt")).references.map(reference => reference.target)).toContain(await seededKnowledge.resolve("The Tideward Hall"));
    expect(await (await getCampaignKnowledge(root,io)).resolve("House Holt")).not.toBeNull();
    expect(await (await getCampaignKnowledge(root,io)).resolve("The Drowning Pact")).not.toBeNull();
    expect(await (await getCampaignKnowledge(root,io)).resolve("The Salt Ring")).not.toBeNull();
    // Runtime state seeded from maps + calendar.
    expect(paths(store)).toContain(norm(`${root}/state/maps.json`));
    expect(paths(store)).toContain(norm(`${root}/state/clocks.json`));
    // The player-facing compendium is never seeded.
    expect(paths(store)).not.toContain(norm(`${root}/campaign/compendium.json`));
  });

  it("does not materialize seed content for a fully custom campaign (no worldSlug)", async () => {
    const { io, store } = mockFileIO();
    const root = await buildCampaignWorld("/camp", setupResult({ campaignName: "Custom Tale" }), io);

    // Chargen PC and scaffold exist, but no seeded NPCs.
    expect(await (await getCampaignKnowledge(root,io)).resolve("Wren")).not.toBeNull();
    expect(await (await getCampaignKnowledge(root,io)).resolve("Maren Holt")).toBeNull();
    expect(paths(store)).not.toContain(norm(`${root}/state/maps.json`));
  });
});
