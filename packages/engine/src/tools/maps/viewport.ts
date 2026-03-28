import type { MapData, ViewAreaOutput } from "@machine-violet/shared/types/maps.js";
import { toCoordKey } from "./coords.js";
import { resolveTerrain, isInBounds } from "./terrain.js";

/**
 * Render a viewport of the map as a text grid + legend.
 * This is the DM's primary spatial read — compact and informative.
 */
export function renderViewport(
  map: MapData,
  centerX: number,
  centerY: number,
  radius: number,
): ViewAreaOutput {
  const legend: string[] = [];
  const entityLabels = new Map<string, string>(); // entity id -> label char
  let nextLabel = 65; // 'A'

  // First pass: collect entities and assign labels
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = centerX + dx;
      const y = centerY + dy;
      const coord = toCoordKey(x, y);
      const entities = map.entities[coord];
      if (entities) {
        for (const entity of entities) {
          if (!entityLabels.has(entity.id)) {
            const label = String.fromCharCode(nextLabel++);
            entityLabels.set(entity.id, label);
            legend.push(
              `${label}: ${entity.type}${entity.id.startsWith("PC:") ? " (PC)" : ""} @ ${coord}${entity.notes ? ` — ${entity.notes}` : ""}`,
            );
          }
        }
      }
    }
  }

  // Build terrain shorthand map
  const terrainChars = new Map<string, string>();
  let nextTerrainChar = 0;
  const TERRAIN_CHARS = ".#~^*+=%@&";

  function getTerrainChar(terrain: string): string {
    if (!terrainChars.has(terrain)) {
      const ch =
        nextTerrainChar < TERRAIN_CHARS.length
          ? TERRAIN_CHARS[nextTerrainChar++]
          : "?";
      terrainChars.set(terrain, ch);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- just set above
    return terrainChars.get(terrain)!;
  }

  // Second pass: render grid
  const rows: string[] = [];

  // Column header
  const colNums: string[] = [];
  for (let dx = -radius; dx <= radius; dx++) {
    colNums.push(String(centerX + dx).padStart(3));
  }
  rows.push("   " + colNums.join(""));

  for (let dy = -radius; dy <= radius; dy++) {
    const y = centerY + dy;
    let row = String(y).padStart(3) + " ";

    for (let dx = -radius; dx <= radius; dx++) {
      const x = centerX + dx;
      const coord = toCoordKey(x, y);

      if (!isInBounds(map, coord)) {
        row += " . ";
        continue;
      }

      // Check for entities first (they take visual priority)
      const entities = map.entities[coord];
      if (entities && entities.length > 0) {
        const label = entityLabels.get(entities[0].id) ?? "?";
        row += ` ${label} `;
        continue;
      }

      // Check for annotations
      if (map.annotations[coord]) {
        row += " ! ";
        continue;
      }

      // Terrain
      const terrain = resolveTerrain(map, coord);
      const ch = getTerrainChar(terrain);
      row += ` ${ch} `;
    }

    rows.push(row);
  }

  // Add terrain legend
  if (terrainChars.size > 0) {
    legend.push("---");
    for (const [terrain, ch] of terrainChars) {
      legend.push(`${ch}: ${terrain}`);
    }
  }

  // Add annotation legend
  const annotationsInView: string[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const coord = toCoordKey(centerX + dx, centerY + dy);
      if (map.annotations[coord]) {
        annotationsInView.push(`! @ ${coord}: ${map.annotations[coord]}`);
      }
    }
  }
  if (annotationsInView.length > 0) {
    legend.push("---");
    legend.push(...annotationsInView);
  }

  return { grid: rows.join("\n"), legend };
}
