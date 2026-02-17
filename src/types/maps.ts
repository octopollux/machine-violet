export type GridType = "square" | "hex";

export interface MapEntity {
  id: string;
  type: string;
  notes?: string;
}

export interface MapRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  terrain: string;
}

export interface MapLink {
  coord: string;
  target: string;
  targetCoord?: string;
  description?: string;
}

export interface MapData {
  id: string;
  gridType: GridType;
  bounds: { width: number; height: number };
  defaultTerrain: string;
  regions: MapRegion[];
  terrain: Record<string, string>;
  entities: Record<string, MapEntity[]>;
  annotations: Record<string, string>;
  links: MapLink[];
  meta: Record<string, string>;
}

/** Coordinate as "x,y" string */
export type CoordKey = string;

export interface ViewAreaInput {
  map: string;
  center: CoordKey;
  radius: number;
}

export interface ViewAreaOutput {
  grid: string;
  legend: string[];
}

export interface DistanceInput {
  map: string;
  from: CoordKey;
  to: CoordKey;
}

export interface PathResult {
  path: CoordKey[];
  distance: number;
}

export interface LineOfSightResult {
  tiles: Array<{
    coord: CoordKey;
    terrain: string;
    entities: MapEntity[];
    annotation?: string;
  }>;
}

export interface TilesInRangeInput {
  map: string;
  center: CoordKey;
  range: number;
  filter?: "entities" | string; // "entities" or a terrain type
}
