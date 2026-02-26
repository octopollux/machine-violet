import type { CoordKey, GridType } from "../../types/maps.js";

/** Parse "x,y" string to numeric coordinates */
export function parseCoord(key: CoordKey): [number, number] {
  const parts = key.split(",");
  if (parts.length !== 2) throw new Error(`Invalid coordinate: "${key}"`);
  const x = parseInt(parts[0], 10);
  const y = parseInt(parts[1], 10);
  if (isNaN(x) || isNaN(y)) throw new Error(`Invalid coordinate: "${key}"`);
  return [x, y];
}

/** Format numeric coordinates to "x,y" string */
export function toCoordKey(x: number, y: number): CoordKey {
  return `${x},${y}`;
}

/** Distance between two coordinates on a square grid (Chebyshev) */
export function squareDistance(
  from: CoordKey,
  to: CoordKey,
): number {
  const [x1, y1] = parseCoord(from);
  const [x2, y2] = parseCoord(to);
  return Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
}

/**
 * Distance between two coordinates on a hex grid (offset coordinates).
 * Uses axial conversion for accurate hex distance.
 */
export function hexDistance(from: CoordKey, to: CoordKey): number {
  const [x1, y1] = parseCoord(from);
  const [x2, y2] = parseCoord(to);

  // Convert offset to cube coordinates (even-q offset)
  const [q1, r1, s1] = offsetToCube(x1, y1);
  const [q2, r2, s2] = offsetToCube(x2, y2);

  return Math.max(
    Math.abs(q1 - q2),
    Math.abs(r1 - r2),
    Math.abs(s1 - s2),
  );
}

function offsetToCube(col: number, row: number): [number, number, number] {
  // Even-q offset
  const q = col;
  const r = row - Math.floor(col / 2);
  const s = -q - r;
  return [q, r, s];
}

/** Get distance using the appropriate grid type */
export function gridDistance(
  gridType: GridType,
  from: CoordKey,
  to: CoordKey,
): number {
  return gridType === "hex"
    ? hexDistance(from, to)
    : squareDistance(from, to);
}

/** Get all adjacent coordinates for a square grid */
export function squareNeighbors(coord: CoordKey): CoordKey[] {
  const [x, y] = parseCoord(coord);
  const neighbors: CoordKey[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      neighbors.push(toCoordKey(x + dx, y + dy));
    }
  }
  return neighbors;
}

/** Get all adjacent coordinates for a hex grid (even-q offset) */
export function hexNeighbors(coord: CoordKey): CoordKey[] {
  const [x, y] = parseCoord(coord);
  const isEvenCol = x % 2 === 0;

  const directions = isEvenCol
    ? [
        [1, 0], [-1, 0], [0, -1], [0, 1],
        [1, -1], [-1, -1],
      ]
    : [
        [1, 0], [-1, 0], [0, -1], [0, 1],
        [1, 1], [-1, 1],
      ];

  return directions.map(([dx, dy]) => toCoordKey(x + dx, y + dy));
}

/** Get neighbors using the appropriate grid type */
export function gridNeighbors(
  gridType: GridType,
  coord: CoordKey,
): CoordKey[] {
  return gridType === "hex"
    ? hexNeighbors(coord)
    : squareNeighbors(coord);
}

/**
 * Get all coordinates along a line between two points (Bresenham's).
 * Used for line of sight.
 */
export function lineBetween(from: CoordKey, to: CoordKey): CoordKey[] {
  const [x0, y0] = parseCoord(from);
  const [x1, y1] = parseCoord(to);

  const coords: CoordKey[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;

  while (true) {
    coords.push(toCoordKey(x, y));
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }

  return coords;
}
