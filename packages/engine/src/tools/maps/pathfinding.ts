import type { MapData, CoordKey, PathResult } from "@machine-violet/shared/types/maps.js";
import { gridNeighbors, gridDistance } from "./coords.js";
import { resolveTerrain, isInBounds } from "./terrain.js";

interface PathOptions {
  impassable?: string[];   // terrain types that cannot be traversed
  terrainCosts?: Record<string, number>; // custom movement costs by terrain
}

/**
 * A* pathfinding between two coordinates.
 * Returns the shortest path and its length.
 */
export function findPath(
  map: MapData,
  from: CoordKey,
  to: CoordKey,
  options: PathOptions = {},
): PathResult | null {
  const impassable = new Set(options.impassable ?? []);
  const terrainCosts = options.terrainCosts ?? {};

  const openSet = new Map<CoordKey, number>(); // coord -> f-score
  const cameFrom = new Map<CoordKey, CoordKey>();
  const gScore = new Map<CoordKey, number>();

  gScore.set(from, 0);
  openSet.set(from, gridDistance(map.gridType, from, to));

  while (openSet.size > 0) {
    // Get node with lowest f-score
    let current: CoordKey = "";
    let lowestF = Infinity;
    for (const [coord, f] of openSet) {
      if (f < lowestF) {
        lowestF = f;
        current = coord;
      }
    }

    if (current === to) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- current always in gScore
      return reconstructPath(cameFrom, current, gScore.get(current)!);
    }

    openSet.delete(current);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- current always in gScore
    const currentG = gScore.get(current)!;

    for (const neighbor of gridNeighbors(map.gridType, current)) {
      if (!isInBounds(map, neighbor)) continue;

      const terrain = resolveTerrain(map, neighbor);
      if (impassable.has(terrain)) continue;

      const moveCost = terrainCosts[terrain] ?? 1;
      const tentativeG = currentG + moveCost;

      if (tentativeG < (gScore.get(neighbor) ?? Infinity)) {
        cameFrom.set(neighbor, current);
        gScore.set(neighbor, tentativeG);
        const h = gridDistance(map.gridType, neighbor, to);
        openSet.set(neighbor, tentativeG + h);
      }
    }
  }

  return null; // No path found
}

function reconstructPath(
  cameFrom: Map<CoordKey, CoordKey>,
  current: CoordKey,
  totalCost: number,
): PathResult {
  const path: CoordKey[] = [current];
  while (cameFrom.has(current)) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- while-loop guarantees presence
    current = cameFrom.get(current)!;
    path.unshift(current);
  }
  return { path, distance: totalCost };
}
