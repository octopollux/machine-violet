import type { MapData, CoordKey, MapRegion } from "../../types/maps.js";
import { parseCoord } from "./coords.js";

/**
 * Resolve terrain at a coordinate using the priority order:
 * 1. Coordinate override (terrain dict) — highest priority
 * 2. Region (last match wins) — bulk areas
 * 3. Default terrain — everything else
 */
export function resolveTerrain(map: MapData, coord: CoordKey): string {
  // 1. Coordinate override
  if (map.terrain[coord]) {
    return map.terrain[coord];
  }

  // 2. Region (last match wins)
  const [x, y] = parseCoord(coord);
  let regionTerrain: string | null = null;
  for (const region of map.regions) {
    if (isInRegion(x, y, region)) {
      regionTerrain = region.terrain;
    }
  }
  if (regionTerrain) {
    return regionTerrain;
  }

  // 3. Default
  return map.defaultTerrain;
}

function isInRegion(x: number, y: number, region: MapRegion): boolean {
  return x >= region.x1 && x <= region.x2 && y >= region.y1 && y <= region.y2;
}

/**
 * Check if a coordinate is within the map bounds.
 */
export function isInBounds(map: MapData, coord: CoordKey): boolean {
  const [x, y] = parseCoord(coord);
  return x >= 0 && x < map.bounds.width && y >= 0 && y < map.bounds.height;
}
