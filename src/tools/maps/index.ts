import type {
  MapData,
  MapEntity,
  CoordKey,
  ViewAreaOutput,
  LineOfSightResult,
  PathResult,
  GridType,
} from "../../types/maps.js";
import { parseCoord, gridDistance, lineBetween, gridNeighbors } from "./coords.js";
import { resolveTerrain, isInBounds } from "./terrain.js";
import { findPath } from "./pathfinding.js";
import { renderViewport } from "./viewport.js";

export { parseCoord, toCoordKey, gridDistance, squareDistance, hexDistance } from "./coords.js";
export { resolveTerrain, isInBounds } from "./terrain.js";
export { findPath } from "./pathfinding.js";
export { renderViewport } from "./viewport.js";

// --- Map Creation ---

/** Create a new empty map */
export function createMap(
  id: string,
  gridType: GridType,
  width: number,
  height: number,
  defaultTerrain: string,
): MapData {
  return {
    id,
    gridType,
    bounds: { width, height },
    defaultTerrain,
    regions: [],
    terrain: {},
    entities: {},
    annotations: {},
    links: [],
    meta: {},
  };
}

/** Define a rectangular terrain region */
export function defineRegion(
  map: MapData,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  terrain: string,
): void {
  map.regions.push({ x1, y1, x2, y2, terrain });
}

/** Batch-place multiple entities */
export function importEntities(
  map: MapData,
  entities: Array<{ coord: CoordKey; entity: MapEntity }>,
): void {
  for (const { coord, entity } of entities) {
    placeEntity(map, coord, entity);
  }
}

// --- Queries ---

/** Render a viewport centered on a point */
export function viewArea(
  map: MapData,
  center: CoordKey,
  radius: number,
): ViewAreaOutput {
  const [cx, cy] = parseCoord(center);
  return renderViewport(map, cx, cy, radius);
}

/** Distance between two coordinates */
export function distance(
  map: MapData,
  from: CoordKey,
  to: CoordKey,
): number {
  return gridDistance(map.gridType, from, to);
}

/** Shortest path between two coordinates */
export function pathBetween(
  map: MapData,
  from: CoordKey,
  to: CoordKey,
  options?: { impassable?: string[]; terrainCosts?: Record<string, number> },
): PathResult | null {
  return findPath(map, from, to, options);
}

/** Tiles and contents along a line between two points */
export function lineOfSight(
  map: MapData,
  from: CoordKey,
  to: CoordKey,
): LineOfSightResult {
  const coords = lineBetween(from, to);

  const tiles = coords
    .filter((coord) => isInBounds(map, coord))
    .map((coord) => ({
      coord,
      terrain: resolveTerrain(map, coord),
      entities: map.entities[coord] ?? [],
      annotation: map.annotations[coord],
    }));

  return { tiles };
}

/** All tiles within range, optionally filtered */
export function tilesInRange(
  map: MapData,
  center: CoordKey,
  range: number,
  filter?: "entities" | string,
): Array<{ coord: CoordKey; terrain: string; entities: MapEntity[] }> {
  const results: Array<{
    coord: CoordKey;
    terrain: string;
    entities: MapEntity[];
  }> = [];

  // BFS to find all tiles within range
  const visited = new Set<CoordKey>();
  const queue: Array<{ coord: CoordKey; dist: number }> = [
    { coord: center, dist: 0 },
  ];
  visited.add(center);

  while (queue.length > 0) {
    const { coord, dist } = queue.shift()!;

    if (dist > range) continue;

    const terrain = resolveTerrain(map, coord);
    const entities = map.entities[coord] ?? [];

    // Apply filter
    if (filter === "entities") {
      if (entities.length > 0) {
        results.push({ coord, terrain, entities });
      }
    } else if (filter) {
      if (terrain === filter) {
        results.push({ coord, terrain, entities });
      }
    } else {
      results.push({ coord, terrain, entities });
    }

    if (dist < range) {
      for (const neighbor of gridNeighbors(map.gridType, coord)) {
        if (!visited.has(neighbor) && isInBounds(map, neighbor)) {
          visited.add(neighbor);
          queue.push({ coord: neighbor, dist: dist + 1 });
        }
      }
    }
  }

  return results;
}

/** Find nearest entity or terrain of a given type */
export function findNearest(
  map: MapData,
  from: CoordKey,
  type: string,
): { coord: CoordKey; distance: number } | null {
  // BFS from the starting point
  const visited = new Set<CoordKey>();
  const queue: Array<{ coord: CoordKey; dist: number }> = [
    { coord: from, dist: 0 },
  ];
  visited.add(from);

  while (queue.length > 0) {
    const { coord, dist } = queue.shift()!;

    // Check entities at this coordinate
    const entities = map.entities[coord] ?? [];
    for (const entity of entities) {
      if (entity.type === type || entity.id === type) {
        if (coord !== from) {
          return { coord, distance: dist };
        }
      }
    }

    // Check terrain
    const terrain = resolveTerrain(map, coord);
    if (terrain === type && coord !== from) {
      return { coord, distance: dist };
    }

    for (const neighbor of gridNeighbors(map.gridType, coord)) {
      if (!visited.has(neighbor) && isInBounds(map, neighbor)) {
        visited.add(neighbor);
        queue.push({ coord: neighbor, dist: dist + 1 });
      }
    }
  }

  return null;
}

// --- Mutations ---

/** Place an entity on a tile */
export function placeEntity(
  map: MapData,
  coord: CoordKey,
  entity: MapEntity,
): void {
  if (!map.entities[coord]) {
    map.entities[coord] = [];
  }
  map.entities[coord].push(entity);
}

/** Move an entity to a new coordinate */
export function moveEntity(
  map: MapData,
  entityId: string,
  to: CoordKey,
): void {
  // Find and remove from current position
  for (const [coord, entities] of Object.entries(map.entities)) {
    const idx = entities.findIndex((e) => e.id === entityId);
    if (idx !== -1) {
      const entity = entities.splice(idx, 1)[0];
      if (entities.length === 0) {
        delete map.entities[coord];
      }
      // Place at new position
      if (!map.entities[to]) {
        map.entities[to] = [];
      }
      map.entities[to].push(entity);
      return;
    }
  }
  throw new Error(`Entity not found: ${entityId}`);
}

/** Remove an entity from the map */
export function removeEntity(map: MapData, entityId: string): void {
  for (const [coord, entities] of Object.entries(map.entities)) {
    const idx = entities.findIndex((e) => e.id === entityId);
    if (idx !== -1) {
      entities.splice(idx, 1);
      if (entities.length === 0) {
        delete map.entities[coord];
      }
      return;
    }
  }
  throw new Error(`Entity not found: ${entityId}`);
}

/** Set terrain at a coordinate or define a region */
export function setTerrain(
  map: MapData,
  target: CoordKey | { x1: number; y1: number; x2: number; y2: number },
  terrain: string,
): void {
  if (typeof target === "string") {
    map.terrain[target] = terrain;
  } else {
    defineRegion(map, target.x1, target.y1, target.x2, target.y2, terrain);
  }
}

/** Add or update an annotation */
export function annotate(
  map: MapData,
  coord: CoordKey,
  text: string,
): void {
  map.annotations[coord] = text;
}
