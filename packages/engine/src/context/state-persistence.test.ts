import { describe, it, expect, vi, beforeEach } from "vitest";
import { StatePersister, STATE_FILES } from "./state-persistence.js";
import type { FileIO } from "../agents/scene-manager.js";
import type { CombatState } from "@machine-violet/shared/types/combat.js";
import type { MapData } from "@machine-violet/shared/types/maps.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";
import { norm } from "../utils/paths.js";
let files: Record<string, string>;

function mockFileIO(): FileIO {
  return {
    readFile: vi.fn(async (path: string) => {
      const content = files[norm(path)];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    }),
    writeFile: vi.fn(async (path: string, content: string) => { files[norm(path)] = content; }),
    appendFile: vi.fn(async (path: string, content: string) => { files[norm(path)] = (files[norm(path)] ?? "") + content; }),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (path: string) => norm(path) in files),
    listDir: vi.fn(async () => []),
  };
}

beforeEach(() => {
  files = {};
});

describe("StatePersister", () => {
  it("round-trips combat state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const combat: CombatState = {
      active: true,
      order: [{ id: "Aldric", initiative: 18, type: "pc" }],
      round: 3,
      currentTurn: 0,
    };

    persister.persistCombat(combat);
    // Wait for fire-and-forget write
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.combat).toEqual(combat);
  });

  it("round-trips clocks state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const clocks = createClocksState();
    clocks.calendar.current = 1440;

    persister.persistClocks(clocks);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.clocks).toEqual(clocks);
  });

  it("round-trips maps state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const maps: Record<string, MapData> = {
      tavern: {
        id: "tavern",
        gridType: "square",
        bounds: { width: 10, height: 10 },
        defaultTerrain: "stone",
        regions: [],
        terrain: {},
        entities: {},
        annotations: {},
        links: [],
        meta: {},
      },
    };

    persister.persistMaps(maps);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.maps).toEqual(maps);
  });

  it("round-trips decks state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const decks = createDecksState();

    persister.persistDecks(decks);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.decks).toEqual(decks);
  });

  it("round-trips objectives state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const objectives = createObjectivesState();
    objectives.objectives["1"] = {
      id: "1",
      title: "Find the missing scout",
      description: "Ranger Eldan went into the Thornwood.",
      status: "active",
      created_scene: 2,
    };
    objectives.next_id = 2;
    objectives.current_scene = 5;

    persister.persistObjectives(objectives);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.objectives).toEqual(objectives);
  });

  it("round-trips scene state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const scene = {
      precis: "The party entered the dungeon.",
      playerReads: [{ engagement: "high" as const, focus: ["combat"], tone: "aggressive" as const, pacing: "pushing_forward" as const, offScript: false }],
      activePlayerIndex: 1,
    };

    persister.persistScene(scene);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.scene).toEqual(scene);
  });

  it("round-trips conversation exchanges", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const exchanges = [
      {
        user: { role: "user" as const, content: "I search the room." },
        assistant: { role: "assistant" as const, content: "You find a dusty chest." },
        toolResults: [],
        estimatedTokens: 50,

      },
      {
        user: { role: "user" as const, content: "I open it." },
        assistant: { role: "assistant" as const, content: "Inside is a golden key." },
        toolResults: [],
        estimatedTokens: 40,

      },
    ];

    persister.persistConversation(exchanges);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.conversation).toEqual(exchanges);
  });

  it("round-trips usage breakdown", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const usage = {
      byTier: {
        large: { input: 1200, output: 200, cached: 5000 },
        medium: { input: 0, output: 0, cached: 0 },
        small: { input: 800, output: 100, cached: 3000 },
      },
      tokens: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 8000, cacheCreationTokens: 0 },
      apiCalls: 5,
    };

    persister.persistUsage(usage);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.usage).toEqual(usage);
  });

  it("round-trips resource state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const resources = {
      displayResources: { Aldric: ["HP", "Spell Slots"] },
      resourceValues: { Aldric: { HP: "24/30", "Spell Slots": "3/4" } },
    };

    persister.persistResources(resources);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.resources).toEqual(resources);
  });

  it("loadAll returns undefined for missing files", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);

    const loaded = await persister.loadAll();
    expect(loaded.combat).toBeUndefined();
    expect(loaded.clocks).toBeUndefined();
    expect(loaded.maps).toBeUndefined();
    expect(loaded.decks).toBeUndefined();
    expect(loaded.scene).toBeUndefined();
    expect(loaded.conversation).toBeUndefined();
    expect(loaded.ui).toBeUndefined();
    expect(loaded.usage).toBeUndefined();
    expect(loaded.resources).toBeUndefined();
  });

  it("round-trips UI theme state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const ui = { styleName: "gothic", variant: "combat" as const };

    persister.persistUI(ui);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.ui).toEqual(ui);
  });

  it("round-trips UI state with modelines", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const ui = {
      styleName: "gothic",
      variant: "exploration" as const,
      modelines: { Aldric: "HP 45/50 | Blessed", Rook: "HP 28/30 | Poisoned" },
    };

    persister.persistUI(ui);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.ui).toEqual(ui);
    expect(loaded.ui!.modelines).toEqual({ Aldric: "HP 45/50 | Blessed", Rook: "HP 28/30 | Poisoned" });
  });

  it("round-trips scene state with null fields (explicit-empty)", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const scene = {
      precis: "The party rests.",
      openThreads: null,
      npcIntents: null,
      playerReads: [{ engagement: "high" as const, focus: ["combat"], tone: "aggressive" as const, pacing: "pushing_forward" as const, offScript: false }],
      activePlayerIndex: 0,
    };

    persister.persistScene(scene);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.scene).toBeDefined();
    expect(loaded.scene!.precis).toBe("The party rests.");
    expect(loaded.scene!.openThreads).toBeNull();
    expect(loaded.scene!.npcIntents).toBeNull();
  });

  it("distinguishes null from absent in scene state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    // Scene with no openThreads/npcIntents keys at all (absent = never assessed)
    const minimal = { precis: "test", playerReads: [], activePlayerIndex: 0 };
    files[norm("/tmp/campaign/state/scene.json")] = JSON.stringify(minimal);

    const loaded = await persister.loadAll();
    expect(loaded.scene!.openThreads).toBeUndefined();
    expect(loaded.scene!.npcIntents).toBeUndefined();

    // Now set them to null (explicitly cleared)
    const cleared = { ...minimal, openThreads: null, npcIntents: null };
    files[norm("/tmp/campaign/state/scene.json")] = JSON.stringify(cleared);

    const loaded2 = await persister.loadAll();
    expect(loaded2.scene!.openThreads).toBeNull();
    expect(loaded2.scene!.npcIntents).toBeNull();
  });

  it("round-trips UI state with null keyColor and modelines", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    const ui = {
      styleName: "gothic",
      variant: "exploration" as const,
      keyColor: null,
      modelines: null,
    };

    persister.persistUI(ui);
    await vi.waitFor(() => expect(fio.writeFile).toHaveBeenCalled());

    const loaded = await persister.loadAll();
    expect(loaded.ui).toBeDefined();
    expect(loaded.ui!.keyColor).toBeNull();
    expect(loaded.ui!.modelines).toBeNull();
  });

  it("distinguishes null from absent in UI state", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    // UI with no keyColor/modelines keys (absent = never configured)
    const minimal = { styleName: "clean", variant: "exploration" };
    files[norm("/tmp/campaign/state/ui.json")] = JSON.stringify(minimal);

    const loaded = await persister.loadAll();
    expect(loaded.ui!.keyColor).toBeUndefined();
    expect(loaded.ui!.modelines).toBeUndefined();

    // Now set them to null (explicitly none)
    const cleared = { ...minimal, keyColor: null, modelines: null };
    files[norm("/tmp/campaign/state/ui.json")] = JSON.stringify(cleared);

    const loaded2 = await persister.loadAll();
    expect(loaded2.ui!.keyColor).toBeNull();
    expect(loaded2.ui!.modelines).toBeNull();
  });

  it("loads old UI state without modelines (backward compat)", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    // Simulate old-format UI state (no modelines field)
    const oldUI = { styleName: "arcane", variant: "exploration" };
    files[norm("/tmp/campaign/state/ui.json")] = JSON.stringify(oldUI);

    const loaded = await persister.loadAll();
    expect(loaded.ui).toBeDefined();
    expect(loaded.ui!.styleName).toBe("arcane");
    expect(loaded.ui!.variant).toBe("exploration");
    expect(loaded.ui!.modelines).toBeUndefined();
  });

  it("persist methods swallow errors silently", async () => {
    const fio = mockFileIO();
    (fio.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));
    const persister = new StatePersister("/tmp/campaign", fio);

    // Should not throw
    persister.persistCombat(createCombatState());
    persister.persistClocks(createClocksState());
    persister.persistMaps({});
    persister.persistDecks(createDecksState());
    persister.persistScene({ precis: "", playerReads: [], activePlayerIndex: 0 });

    // Give fire-and-forget promises time to settle
    await new Promise((r) => setTimeout(r, 10));
  });

  it("calls onError callback when write fails", async () => {
    const fio = mockFileIO();
    (fio.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));
    const onError = vi.fn();
    const persister = new StatePersister("/tmp/campaign", fio, onError);

    persister.persistCombat(createCombatState());

    // Give fire-and-forget promise time to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0][0].message).toBe("disk full");
  });

  it("calls onError callback when read fails", async () => {
    const fio = mockFileIO();
    (fio.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("permission denied"));
    const onError = vi.fn();
    const persister = new StatePersister("/tmp/campaign", fio, onError);

    const loaded = await persister.loadAll();
    expect(loaded.combat).toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toBe("permission denied");
  });

  it("silently ignores ENOENT on read (missing optional state files)", async () => {
    const fio = mockFileIO();
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    (fio.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(enoent);
    const onError = vi.fn();
    const persister = new StatePersister("/tmp/campaign", fio, onError);

    const loaded = await persister.loadAll();
    expect(loaded.combat).toBeUndefined();
    expect(loaded.scene).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("display log", () => {
  it("appendDisplayLog appends text to display-log.md", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);

    persister.appendDisplayLog("Hello world\n");
    persister.appendDisplayLog("Second line\n");
    await persister.flush();

    expect(files[norm("/tmp/campaign/state/display-log.md")]).toBe("Hello world\nSecond line\n");
  });

  it("loadDisplayLogTail returns last N lines", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);

    files[norm("/tmp/campaign/state/display-log.md")] = "line1\nline2\nline3\nline4\nline5\n";

    const tail = await persister.loadDisplayLogTail(3);
    expect(tail).toEqual(["line3", "line4", "line5"]);
  });

  it("loadDisplayLogTail returns all lines when fewer than max", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);

    files[norm("/tmp/campaign/state/display-log.md")] = "line1\nline2\n";

    const tail = await persister.loadDisplayLogTail(200);
    expect(tail).toEqual(["line1", "line2"]);
  });

  it("loadDisplayLogTail returns empty for missing file", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);

    const tail = await persister.loadDisplayLogTail(200);
    expect(tail).toEqual([]);
  });

  it("loadDisplayLogFull returns all lines", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);

    files[norm("/tmp/campaign/state/display-log.md")] = "line1\nline2\nline3\nline4\nline5\n";

    const all = await persister.loadDisplayLogFull();
    expect(all).toEqual(["line1", "line2", "line3", "line4", "line5"]);
  });

  it("loadDisplayLogFull returns empty for missing file", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);

    const all = await persister.loadDisplayLogFull();
    expect(all).toEqual([]);
  });

  it("appendDisplayLog swallows errors silently", async () => {
    const fio = mockFileIO();
    (fio.appendFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));
    const onError = vi.fn();
    const persister = new StatePersister("/tmp/campaign", fio, onError);

    persister.appendDisplayLog("test\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("write serialization", () => {
  it("serializes writes to the same file", async () => {
    const writeOrder: string[] = [];
    const fio = mockFileIO();
    (fio.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (_path: string, content: string) => {
        writeOrder.push(content);
        // Simulate slow I/O
        await new Promise((r) => setTimeout(r, 10));
        files[norm(_path)] = content;
      },
    );

    const persister = new StatePersister("/tmp/campaign", fio);
    persister.persistScene({ precis: "first", playerReads: [], activePlayerIndex: 0 });
    persister.persistScene({ precis: "second", playerReads: [], activePlayerIndex: 0 });

    await persister.flush();
    expect(writeOrder).toHaveLength(2);
    expect(writeOrder[0]).toContain("first");
    expect(writeOrder[1]).toContain("second");
  });

  it("concurrent writes to different files proceed independently", async () => {
    const callTimes: Record<string, number[]> = {};
    const fio = mockFileIO();
    (fio.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (path: string, content: string) => {
        const key = norm(path);
        if (!callTimes[key]) callTimes[key] = [];
        callTimes[key].push(Date.now());
        await new Promise((r) => setTimeout(r, 20));
        files[key] = content;
      },
    );

    const persister = new StatePersister("/tmp/campaign", fio);
    persister.persistCombat({ active: false, order: [], round: 0, currentTurn: 0 });
    persister.persistClocks(createClocksState());

    await persister.flush();
    // Both files were written
    const combatKey = norm("/tmp/campaign/state/combat.json");
    const clocksKey = norm("/tmp/campaign/state/clocks.json");
    expect(callTimes[combatKey]).toHaveLength(1);
    expect(callTimes[clocksKey]).toHaveLength(1);
    // They started concurrently (within 5ms of each other)
    expect(Math.abs(callTimes[combatKey][0] - callTimes[clocksKey][0])).toBeLessThan(15);
  });

  it("error in one write does not block subsequent writes", async () => {
    let callCount = 0;
    const fio = mockFileIO();
    (fio.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (path: string, content: string) => {
        callCount++;
        if (callCount === 1) throw new Error("disk full");
        files[norm(path)] = content;
      },
    );

    const persister = new StatePersister("/tmp/campaign", fio);
    persister.persistScene({ precis: "first", playerReads: [], activePlayerIndex: 0 });
    persister.persistScene({ precis: "second", playerReads: [], activePlayerIndex: 0 });

    await persister.flush();
    expect(callCount).toBe(2);
    // Second write succeeded
    const loaded = await persister.loadAll();
    expect(loaded.scene?.precis).toBe("second");
  });

  it("flush() resolves after all pending writes complete", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);

    persister.persistCombat({ active: false, order: [], round: 0, currentTurn: 0 });
    persister.persistClocks(createClocksState());
    persister.persistScene({ precis: "test", playerReads: [], activePlayerIndex: 0 });

    await persister.flush();
    const loaded = await persister.loadAll();
    expect(loaded.combat).toBeDefined();
    expect(loaded.clocks).toBeDefined();
    expect(loaded.scene).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Format spec compliance (§4) — assert on raw JSON, not round-trip equality.
// These tests catch field renames and structural changes that round-trip tests miss.
// ---------------------------------------------------------------------------

/** Helper: persist, flush, return parsed JSON from the in-memory file store. */
async function persistAndParse<T>(
  persist: (p: StatePersister) => void,
  stateFile: string,
): Promise<{ json: T; raw: string }> {
  const fio = mockFileIO();
  const persister = new StatePersister("/tmp/campaign", fio);
  persist(persister);
  await persister.flush();
  const raw = files[norm(`/tmp/campaign/${stateFile}`)];
  return { json: JSON.parse(raw) as T, raw };
}

describe("format spec compliance: field names (§4)", () => {
  it("combat.json uses spec field names (§4.1)", async () => {
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistCombat({
        active: true,
        order: [{ id: "Aldric", initiative: 18, type: "pc" }],
        round: 3,
        currentTurn: 0,
      }),
      STATE_FILES.combat,
    );
    expect(Object.keys(json).sort()).toEqual(["active", "currentTurn", "order", "round"]);
    expect(json.active).toBe(true);
    expect(json.currentTurn).toBe(0);
    const entry = (json.order as Record<string, unknown>[])[0];
    expect(Object.keys(entry).sort()).toEqual(["id", "initiative", "type"]);
  });

  it("clocks.json uses spec field names including snake_case (§4.2)", async () => {
    const clocks = createClocksState();
    clocks.calendar.epoch = "Dawn of the First Age";
    clocks.calendar.display_format = "fantasy";
    clocks.calendar.alarms = [{
      id: "caravan",
      fires_at: 1440,
      message: "The caravan arrives.",
      repeating: 10080,
    }];
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistClocks(clocks),
      STATE_FILES.clocks,
    );
    expect(Object.keys(json).sort()).toEqual(["calendar", "combat"]);
    const cal = json.calendar as Record<string, unknown>;
    expect(cal).toHaveProperty("display_format", "fantasy");
    expect(cal).toHaveProperty("epoch");
    expect(cal).toHaveProperty("current");
    const alarm = (cal.alarms as Record<string, unknown>[])[0];
    expect(alarm).toHaveProperty("fires_at", 1440);
    expect(alarm).toHaveProperty("repeating", 10080);
  });

  it("maps.json uses spec field names (§4.3)", async () => {
    const { json } = await persistAndParse<Record<string, Record<string, unknown>>>(
      (p) => p.persistMaps({
        tavern: {
          id: "tavern",
          gridType: "square",
          bounds: { width: 10, height: 10 },
          defaultTerrain: "stone",
          regions: [{ x1: 0, y1: 0, x2: 5, y2: 3, terrain: "bar" }],
          terrain: { "10,7": "firepit" },
          entities: { "3,2": [{ id: "Hilde", type: "npc" }] },
          annotations: { "10,7": "A warm fire." },
          links: [{ coord: "19,7", target: "upstairs", targetCoord: "0,7", description: "Stairs up" }],
          meta: { lighting: "dim" },
        },
      }),
      STATE_FILES.maps,
    );
    const map = json["tavern"];
    expect(Object.keys(map).sort()).toEqual([
      "annotations", "bounds", "defaultTerrain", "entities",
      "gridType", "id", "links", "meta", "regions", "terrain",
    ]);
    expect(map.gridType).toBe("square");
    expect(map.defaultTerrain).toBe("stone");
  });

  it("decks.json uses spec field names (§4.4)", async () => {
    const decks = createDecksState();
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistDecks(decks),
      STATE_FILES.decks,
    );
    expect(json).toHaveProperty("decks");
  });

  it("objectives.json uses snake_case field names (§4.5)", async () => {
    const objectives = createObjectivesState();
    objectives.objectives["1"] = {
      id: "1",
      title: "Find the scout",
      description: "Ranger Eldan is missing.",
      status: "active",
      created_scene: 2,
    };
    objectives.next_id = 2;
    objectives.current_scene = 5;

    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistObjectives(objectives),
      STATE_FILES.objectives,
    );
    // Top-level snake_case keys
    expect(json).toHaveProperty("next_id", 2);
    expect(json).toHaveProperty("current_scene", 5);
    // Objective entry snake_case keys
    const obj = (json as { objectives: Record<string, Record<string, unknown>> }).objectives["1"];
    expect(obj).toHaveProperty("created_scene", 2);
    expect(Object.keys(obj).sort()).toEqual([
      "created_scene", "description", "id", "status", "title",
    ]);
  });

  it("scene.json uses spec field names (§4.6)", async () => {
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistScene({
        precis: "The party rests.",
        openThreads: "Who poisoned the well?",
        npcIntents: null,
        playerReads: [{ engagement: "high" as const, focus: ["combat"], tone: "aggressive" as const, pacing: "pushing_forward" as const, offScript: false }],
        activePlayerIndex: 0,
      }),
      STATE_FILES.scene,
    );
    expect(Object.keys(json).sort()).toEqual([
      "activePlayerIndex", "npcIntents", "openThreads", "playerReads", "precis",
    ]);
    expect(json.openThreads).toBe("Who poisoned the well?");
    expect(json.npcIntents).toBeNull();
  });

  it("scene.json omits absent optional fields (§4.6)", async () => {
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistScene({
        precis: "test",
        playerReads: [],
        activePlayerIndex: 0,
      }),
      STATE_FILES.scene,
    );
    expect("openThreads" in json).toBe(false);
    expect("npcIntents" in json).toBe(false);
  });

  it("conversation.json uses spec field names (§4.7)", async () => {
    const { json } = await persistAndParse<Record<string, unknown>[]>(
      (p) => p.persistConversation([{
        user: { role: "user" as const, content: "Hello" },
        assistant: { role: "assistant" as const, content: "Hi" },
        toolResults: [],
        estimatedTokens: 50,
      }]),
      STATE_FILES.conversation,
    );
    const exchange = json[0];
    expect(exchange).toHaveProperty("user");
    expect(exchange).toHaveProperty("assistant");
    expect(exchange).toHaveProperty("toolResults");
    expect(exchange).toHaveProperty("estimatedTokens");
  });

  it("ui.json uses spec field names (§4.8)", async () => {
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistUI({
        styleName: "gothic",
        variant: "combat",
        keyColor: "#8844cc",
        modelines: { left: "The Sunken Citadel" },
      }),
      STATE_FILES.ui,
    );
    expect(Object.keys(json).sort()).toEqual(["keyColor", "modelines", "styleName", "variant"]);
  });

  it("usage.json uses spec field names (§4.9)", async () => {
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistUsage({
        byTier: {
          large: { input: 1200, output: 200, cached: 5000 },
          medium: { input: 0, output: 0, cached: 0 },
          small: { input: 800, output: 100, cached: 3000 },
        },
        tokens: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 8000, cacheCreationTokens: 0 },
        apiCalls: 5,
      }),
      STATE_FILES.usage,
    );
    expect(json).toHaveProperty("byTier");
    expect(json).toHaveProperty("tokens");
    expect(json).toHaveProperty("apiCalls");
    const tier = (json.byTier as Record<string, Record<string, unknown>>).large;
    expect(Object.keys(tier).sort()).toEqual(["cached", "input", "output"]);
    // Token aggregate field names — code uses camelCase (spec updated to match)
    const tokens = json.tokens as Record<string, unknown>;
    expect(tokens).toHaveProperty("inputTokens");
    expect(tokens).toHaveProperty("outputTokens");
    expect(tokens).toHaveProperty("cacheReadTokens");
    expect(tokens).toHaveProperty("cacheCreationTokens");
  });

  it("resources.json uses spec field names (§4.10)", async () => {
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistResources({
        displayResources: { Aldric: ["HP"] },
        resourceValues: { Aldric: { HP: "24/30" } },
      }),
      STATE_FILES.resources,
    );
    expect(Object.keys(json).sort()).toEqual(["displayResources", "resourceValues"]);
  });
});

describe("format spec compliance: null semantics in JSON (§1.1)", () => {
  it("null scene fields write JSON null, not absent key", async () => {
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistScene({
        precis: null,
        openThreads: null,
        npcIntents: null,
        playerReads: [],
        activePlayerIndex: 0,
      }),
      STATE_FILES.scene,
    );
    expect("precis" in json).toBe(true);
    expect(json.precis).toBeNull();
    expect("openThreads" in json).toBe(true);
    expect(json.openThreads).toBeNull();
    expect("npcIntents" in json).toBe(true);
    expect(json.npcIntents).toBeNull();
  });

  it("null UI fields write JSON null, not absent key", async () => {
    const { json } = await persistAndParse<Record<string, unknown>>(
      (p) => p.persistUI({
        styleName: "gothic",
        variant: "exploration",
        keyColor: null,
        modelines: null,
      }),
      STATE_FILES.ui,
    );
    expect("keyColor" in json).toBe(true);
    expect(json.keyColor).toBeNull();
    expect("modelines" in json).toBe(true);
    expect(json.modelines).toBeNull();
  });
});

describe("format spec compliance: JSON formatting (§4)", () => {
  it("state files use 2-space indentation", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    persister.persistCombat({ active: false, order: [], round: 0, currentTurn: 0 });
    persister.persistScene({ precis: "test", playerReads: [], activePlayerIndex: 0 });
    persister.persistUI({ styleName: "clean", variant: "exploration" });
    await persister.flush();

    // All pretty-printed files should start with 2-space indent on the first key
    for (const file of [STATE_FILES.combat, STATE_FILES.scene, STATE_FILES.ui]) {
      const raw = files[norm(`/tmp/campaign/${file}`)];
      const lines = raw.split("\n");
      // Second line should start with exactly 2 spaces (first indented key)
      expect(lines[1]).toMatch(/^ {2}"/);
    }
  });

  it("conversation.json uses compact format (no indentation)", async () => {
    const fio = mockFileIO();
    const persister = new StatePersister("/tmp/campaign", fio);
    persister.persistConversation([{
      user: { role: "user" as const, content: "Hello" },
      assistant: { role: "assistant" as const, content: "Hi" },
      toolResults: [],
      estimatedTokens: 50,
    }]);
    await persister.flush();

    const raw = files[norm(`/tmp/campaign/${STATE_FILES.conversation}`)];
    // Compact JSON has no newlines (single line)
    expect(raw.split("\n")).toHaveLength(1);
  });
});
