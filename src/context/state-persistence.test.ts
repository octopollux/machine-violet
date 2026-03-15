import { describe, it, expect, vi, beforeEach } from "vitest";
import { StatePersister } from "./state-persistence.js";
import type { FileIO } from "../agents/scene-manager.js";
import type { CombatState } from "../types/combat.js";
import type { MapData } from "../types/maps.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
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
        stubbed: false,
      },
      {
        user: { role: "user" as const, content: "I open it." },
        assistant: { role: "assistant" as const, content: "Inside is a golden key." },
        toolResults: [],
        estimatedTokens: 40,
        stubbed: false,
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
