import { KNOWN_SYSTEMS, findSystem, listAvailableSystems } from "./systems.js";
import type { FileIO } from "../agents/scene-manager.js";

const norm = (p: string) => p.replace(/\\/g, "/");

function mockIO(dirs: Record<string, string[]> = {}): FileIO {
  return {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => {
      const key = norm(p);
      return Object.keys(dirs).some((k) => norm(k) === key);
    }),
    listDir: vi.fn(async (p: string) => {
      const key = norm(p);
      for (const [k, v] of Object.entries(dirs)) {
        if (norm(k) === key) return v;
      }
      return [];
    }),
  };
}

describe("KNOWN_SYSTEMS", () => {
  it("contains dnd-5e", () => {
    expect(KNOWN_SYSTEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "dnd-5e", bundled: true, hasRuleCard: true }),
      ]),
    );
  });
});

describe("findSystem", () => {
  it("finds dnd-5e by slug", () => {
    const sys = findSystem("dnd-5e");
    expect(sys).toBeDefined();
    expect(sys!.name).toBe("D&D 5th Edition");
  });

  it("returns undefined for unknown slug", () => {
    expect(findSystem("not-a-system")).toBeUndefined();
  });
});

describe("listAvailableSystems", () => {
  it("returns known systems with processed=false when no dirs exist", async () => {
    const io = mockIO({});
    const systems = await listAvailableSystems(io, "/home");
    expect(systems.length).toBe(1);
    expect(systems[0].slug).toBe("dnd-5e");
    expect(systems[0].processed).toBe(false);
  });

  it("marks known systems as processed when dir exists", async () => {
    const io = mockIO({
      "/home/systems": ["dnd-5e"],
    });
    const systems = await listAvailableSystems(io, "/home");
    const dnd = systems.find((s) => s.slug === "dnd-5e");
    expect(dnd).toBeDefined();
    expect(dnd!.processed).toBe(true);
  });

  it("discovers custom systems not in known list", async () => {
    const io = mockIO({
      "/home/systems": ["dnd-5e", "my-homebrew"],
    });
    const systems = await listAvailableSystems(io, "/home");
    expect(systems.length).toBe(2);
    const custom = systems.find((s) => s.slug === "my-homebrew");
    expect(custom).toBeDefined();
    expect(custom!.bundled).toBe(false);
    expect(custom!.processed).toBe(true);
    expect(custom!.name).toBe("my-homebrew");
  });

  it("handles missing systems directory gracefully", async () => {
    const io = mockIO({});
    const systems = await listAvailableSystems(io, "/nonexistent");
    expect(systems.length).toBe(1); // just known systems
  });
});
