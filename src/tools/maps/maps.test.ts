import { describe, it, expect, beforeEach } from "vitest";
import type { MapData } from "../../types/maps.js";
import {
  createMap,
  defineRegion,
  placeEntity,
  moveEntity,
  removeEntity,
  setTerrain,
  annotate,
  importEntities,
  viewArea,
  distance,
  pathBetween,
  lineOfSight,
  tilesInRange,
  findNearest,
  resolveTerrain,
  squareDistance,
  hexDistance,
  parseCoord,
  toCoordKey,
} from "./index.js";

let map: MapData;

beforeEach(() => {
  map = createMap("test", "square", 20, 20, "grass");
});

describe("coordinates", () => {
  it("parses valid coordinates", () => {
    expect(parseCoord("5,10")).toEqual([5, 10]);
    expect(parseCoord("0,0")).toEqual([0, 0]);
  });

  it("rejects invalid coordinates", () => {
    expect(() => parseCoord("abc")).toThrow("Invalid coordinate");
    expect(() => parseCoord("1,2,3")).toThrow("Invalid coordinate");
  });

  it("formats coordinates", () => {
    expect(toCoordKey(5, 10)).toBe("5,10");
  });
});

describe("distance", () => {
  it("calculates square grid distance (Chebyshev)", () => {
    expect(squareDistance("0,0", "3,4")).toBe(4);
    expect(squareDistance("0,0", "0,0")).toBe(0);
    expect(squareDistance("0,0", "5,0")).toBe(5);
    expect(squareDistance("0,0", "0,5")).toBe(5);
    expect(squareDistance("0,0", "3,3")).toBe(3); // diagonal
  });

  it("calculates hex grid distance", () => {
    expect(hexDistance("0,0", "0,0")).toBe(0);
    expect(hexDistance("0,0", "1,0")).toBe(1);
    expect(hexDistance("0,0", "2,0")).toBe(2);
  });

  it("uses the distance tool wrapper", () => {
    expect(distance(map, "0,0", "5,5")).toBe(5);
  });
});

describe("terrain resolution", () => {
  it("returns default terrain", () => {
    expect(resolveTerrain(map, "5,5")).toBe("grass");
  });

  it("returns region terrain", () => {
    defineRegion(map, 0, 0, 5, 5, "forest");
    expect(resolveTerrain(map, "3,3")).toBe("forest");
    expect(resolveTerrain(map, "6,6")).toBe("grass");
  });

  it("last region wins", () => {
    defineRegion(map, 0, 0, 10, 10, "forest");
    defineRegion(map, 3, 3, 7, 7, "swamp");
    expect(resolveTerrain(map, "5,5")).toBe("swamp");
    expect(resolveTerrain(map, "1,1")).toBe("forest");
  });

  it("coordinate override beats region", () => {
    defineRegion(map, 0, 0, 10, 10, "forest");
    setTerrain(map, "5,5", "lava");
    expect(resolveTerrain(map, "5,5")).toBe("lava");
  });
});

describe("entity management", () => {
  it("places an entity", () => {
    placeEntity(map, "5,5", { id: "G1", type: "Goblin" });
    expect(map.entities["5,5"]).toHaveLength(1);
    expect(map.entities["5,5"][0].id).toBe("G1");
  });

  it("places multiple entities on same tile", () => {
    placeEntity(map, "5,5", { id: "G1", type: "Goblin" });
    placeEntity(map, "5,5", { id: "chest", type: "locked chest" });
    expect(map.entities["5,5"]).toHaveLength(2);
  });

  it("moves an entity", () => {
    placeEntity(map, "5,5", { id: "G1", type: "Goblin" });
    moveEntity(map, "G1", "7,7");
    expect(map.entities["5,5"]).toBeUndefined();
    expect(map.entities["7,7"]).toHaveLength(1);
    expect(map.entities["7,7"][0].id).toBe("G1");
  });

  it("removes an entity", () => {
    placeEntity(map, "5,5", { id: "G1", type: "Goblin" });
    removeEntity(map, "G1");
    expect(map.entities["5,5"]).toBeUndefined();
  });

  it("throws on moving nonexistent entity", () => {
    expect(() => moveEntity(map, "nope", "1,1")).toThrow("Entity not found");
  });

  it("throws on removing nonexistent entity", () => {
    expect(() => removeEntity(map, "nope")).toThrow("Entity not found");
  });

  it("batch imports entities", () => {
    importEntities(map, [
      { coord: "1,1", entity: { id: "G1", type: "Goblin" } },
      { coord: "2,2", entity: { id: "G2", type: "Goblin" } },
      { coord: "3,3", entity: { id: "chest", type: "Chest" } },
    ]);
    expect(Object.keys(map.entities)).toHaveLength(3);
  });
});

describe("annotations", () => {
  it("adds an annotation", () => {
    annotate(map, "5,5", "smells like sulfur");
    expect(map.annotations["5,5"]).toBe("smells like sulfur");
  });

  it("overwrites an annotation", () => {
    annotate(map, "5,5", "old note");
    annotate(map, "5,5", "new note");
    expect(map.annotations["5,5"]).toBe("new note");
  });
});

describe("pathfinding", () => {
  it("finds a straight path", () => {
    const result = pathBetween(map, "0,0", "5,0");
    expect(result).not.toBeNull();
    expect(result!.path[0]).toBe("0,0");
    expect(result!.path[result!.path.length - 1]).toBe("5,0");
  });

  it("finds a diagonal path", () => {
    const result = pathBetween(map, "0,0", "3,3");
    expect(result).not.toBeNull();
    expect(result!.distance).toBe(3); // Chebyshev distance
  });

  it("avoids impassable terrain", () => {
    // Create a wall
    for (let y = 0; y < 10; y++) {
      setTerrain(map, `5,${y}`, "wall");
    }
    const result = pathBetween(map, "3,3", "7,3", {
      impassable: ["wall"],
    });
    expect(result).not.toBeNull();
    // Path should go around the wall
    const passesThroughWall = result!.path.some(
      (c) => resolveTerrain(map, c) === "wall",
    );
    expect(passesThroughWall).toBe(false);
  });

  it("returns null for impossible path", () => {
    // Completely wall off the destination
    for (let x = 8; x <= 12; x++) {
      for (let y = 8; y <= 12; y++) {
        setTerrain(map, `${x},${y}`, "wall");
      }
    }
    const result = pathBetween(map, "0,0", "10,10", {
      impassable: ["wall"],
    });
    expect(result).toBeNull();
  });

  it("respects terrain costs", () => {
    defineRegion(map, 3, 0, 3, 19, "swamp");
    const normalPath = pathBetween(map, "0,5", "6,5");
    const costlyPath = pathBetween(map, "0,5", "6,5", {
      terrainCosts: { swamp: 3 },
    });
    // Both should find a path, but the costly one may differ
    expect(normalPath).not.toBeNull();
    expect(costlyPath).not.toBeNull();
  });
});

describe("line of sight", () => {
  it("returns tiles along a line", () => {
    const result = lineOfSight(map, "0,0", "5,0");
    expect(result.tiles).toHaveLength(6); // 0,0 through 5,0
    expect(result.tiles[0].coord).toBe("0,0");
    expect(result.tiles[5].coord).toBe("5,0");
  });

  it("includes entities along the line", () => {
    placeEntity(map, "3,0", { id: "G1", type: "Goblin" });
    const result = lineOfSight(map, "0,0", "5,0");
    const goblinTile = result.tiles.find((t) => t.coord === "3,0");
    expect(goblinTile).toBeDefined();
    expect(goblinTile!.entities).toHaveLength(1);
  });

  it("includes annotations along the line", () => {
    annotate(map, "2,0", "trap here");
    const result = lineOfSight(map, "0,0", "5,0");
    const trapTile = result.tiles.find((t) => t.coord === "2,0");
    expect(trapTile).toBeDefined();
    expect(trapTile!.annotation).toBe("trap here");
  });
});

describe("tilesInRange", () => {
  it("returns all tiles within range", () => {
    const results = tilesInRange(map, "5,5", 2);
    // For a square grid, range 2 from center gives a 5x5 area minus corners that are >2 away
    // With Chebyshev distance, all tiles in the 5x5 square are within range 2
    expect(results.length).toBeGreaterThan(0);
    for (const tile of results) {
      expect(distance(map, "5,5", tile.coord)).toBeLessThanOrEqual(2);
    }
  });

  it("filters by entities", () => {
    placeEntity(map, "5,6", { id: "G1", type: "Goblin" });
    placeEntity(map, "10,10", { id: "G2", type: "Goblin" }); // out of range
    const results = tilesInRange(map, "5,5", 2, "entities");
    expect(results).toHaveLength(1);
    expect(results[0].coord).toBe("5,6");
  });

  it("filters by terrain type", () => {
    setTerrain(map, "5,6", "lava");
    setTerrain(map, "4,5", "lava");
    const results = tilesInRange(map, "5,5", 2, "lava");
    expect(results).toHaveLength(2);
  });
});

describe("findNearest", () => {
  it("finds nearest entity by type", () => {
    placeEntity(map, "8,5", { id: "G1", type: "Goblin" });
    placeEntity(map, "3,5", { id: "G2", type: "Goblin" });
    const result = findNearest(map, "5,5", "Goblin");
    expect(result).not.toBeNull();
    // G2 at 3,5 is distance 2, G1 at 8,5 is distance 3
    expect(result!.coord).toBe("3,5");
    expect(result!.distance).toBe(2);
  });

  it("finds nearest terrain", () => {
    setTerrain(map, "7,5", "lava");
    const result = findNearest(map, "5,5", "lava");
    expect(result).not.toBeNull();
    expect(result!.coord).toBe("7,5");
  });

  it("returns null when nothing found", () => {
    const result = findNearest(map, "5,5", "dragon");
    expect(result).toBeNull();
  });
});

describe("viewport rendering", () => {
  it("renders a basic viewport", () => {
    placeEntity(map, "5,5", { id: "PC:Aldric", type: "player" });
    placeEntity(map, "7,5", { id: "G1", type: "Goblin", notes: "poisoned arrows" });
    annotate(map, "6,6", "trap door");

    const result = viewArea(map, "5,5", 3);
    expect(result.grid).toContain("A"); // Aldric
    expect(result.grid).toContain("B"); // Goblin
    expect(result.grid).toContain("!"); // annotation
    expect(result.legend.length).toBeGreaterThan(0);
    expect(result.legend.some((l) => l.includes("Goblin"))).toBe(true);
    expect(result.legend.some((l) => l.includes("trap door"))).toBe(true);
  });

  it("handles empty viewport", () => {
    const result = viewArea(map, "5,5", 2);
    expect(result.grid).toBeDefined();
    expect(result.legend.length).toBeGreaterThan(0); // at least terrain legend
  });
});

describe("map creation", () => {
  it("creates a map with correct properties", () => {
    const m = createMap("dungeon", "hex", 50, 50, "stone floor");
    expect(m.id).toBe("dungeon");
    expect(m.gridType).toBe("hex");
    expect(m.bounds).toEqual({ width: 50, height: 50 });
    expect(m.defaultTerrain).toBe("stone floor");
  });
});
