# Map System Design

The map system provides the AI DM with a reliable spatial scratchpad. It is **not** player-facing; the player never sees map files or data. The DM reads spatial state, reasons about it, and narrates a rich world to the player. The map only needs to be accurate enough to keep narration spatially consistent.

## Core Principles

- **DM-only tool.** No rendering for the player, no fog of war, no exploration tracking. The partitioned adventure transcript already captures what the player knows.
- **Software handles spatial truth.** Distances, adjacency, and pathfinding are computed by tools so the AI never does spatial arithmetic.
- **The AI handles adjudication.** Tools report facts ("here's what's between A and B"); the DM interprets game-system rules.
- **JSON on disk.** Map files live in the campaign directory as plain JSON. The DM can read them directly as a fallback, but tools are the preferred interface.
- **Only as complex as the DM needs.** No video-game abstractions. Simple structures that the AI can narrate through into a rich world.

## Storage Format

Sparse coordinate-keyed JSON. Only non-default tiles are stored; a 200x200 map that's mostly forest stores only the interesting bits.

```jsonc
{
  "id": "goblin-caves-level1",
  "gridType": "square",           // "square" | "hex"
  "bounds": { "width": 60, "height": 40 },
  "defaultTerrain": "stone floor",
  "regions": [
    // Bulk terrain; simple rectangles. The DM narrates organic shapes.
    { "x1": 0, "y1": 0, "x2": 15, "y2": 10, "terrain": "natural cavern" },
    { "x1": 20, "y1": 5, "x2": 35, "y2": 25, "terrain": "worked stone" }
  ],
  "terrain": {
    // Coordinate overrides, sparse. Takes precedence over regions/default.
    "12,4": "lava",
    "12,5": "lava",
    "13,4": "narrow bridge over lava"
  },
  "entities": {
    // Anything that occupies a tile: creatures, objects, furniture.
    "14,7": [
      { "id": "G1", "type": "Goblin Archer", "notes": "elevated on ledge, poisoned arrows" },
      { "id": "chest-1", "type": "locked chest", "notes": "DC 14, trapped: poison needle" }
    ],
    "8,3": [
      { "id": "PC:Aldric", "type": "player", "notes": "" }
    ]
  },
  "annotations": {
    // Freeform DM notes keyed by coordinate. Traps, smells, lore, whatever.
    "10,10": "faint smell of sulfur grows stronger toward the east",
    "4,7": "stairs down -> goblin-caves-level2.json"
  },
  "links": [
    // Connections to other maps (stairs, portals, exits)
    { "coord": "4,7", "target": "goblin-caves-level2.json", "targetCoord": "4,7", "description": "rough-hewn stairs descending" }
  ],
  "meta": {
    // Anything the DM wants to remember about this map as a whole
    "lighting": "dim (torches along worked stone corridors, none in caverns)",
    "ambient": "dripping water, distant goblin chatter",
    "notes": "goblins rotate sentries every 20 turns; see turn-counter alarm"
  }
}
```

### Terrain resolution order
1. Coordinate override (`terrain` dict) — highest priority
2. Region (`regions` array, last match wins) — bulk areas
3. Default (`defaultTerrain`) — everything else

### Regions
Simple rectangles only. If the fiction requires organic cave boundaries or winding rivers, the DM narrates that; the tiles just need to be close enough for distance/adjacency calculations.

### Verticality
- **Distinct floors** (multi-story dungeon, tower): separate map JSON files connected via `links`.
- **Vertical features within one space** (balcony, pit, elevated ledge): handled in entity notes and annotations. E.g., `"notes": "elevated +10ft, half cover to ground level"`. The DM decides which approach fits when laying out a map.

## Tool Layer

The DM interacts with maps through tools. The tools handle spatial computation; the DM handles game-rule adjudication.

Three consolidated tools cover all map operations. Each uses an `operation` discriminator.

### `map` — the board itself
Create, view, modify terrain and annotations.

- **`create`** — initialize a new map with grid type, bounds, and default terrain.
- **`view`** — render a local viewport as a text grid + legend (the DM's primary spatial read). Square grids render as aligned columns; hex grids use offset-row indentation.
- **`set_terrain`** — update terrain at a single coordinate or a rectangular region.
- **`annotate`** — add or update a freeform annotation on a tile.
- **`define_region`** — set terrain for a rectangular area.

### `map_entity` — things on the map
Place, move, remove tokens; batch import; find nearest.

- **`place`** — add an entity to a tile.
- **`move`** — relocate an entity by ID.
- **`remove`** — remove from the map entirely.
- **`import`** — batch-place multiple entities.
- **`find_nearest`** — nearest entity or terrain of a given type. Returns coordinate + distance.

### `map_query` — spatial questions
Software does the math, returns facts. The DM adjudicates.

- **`distance`** — tile count between two coordinates, respecting grid type (hex vs square).
- **`path`** — shortest path, optionally respecting terrain costs or impassable tiles. Returns the path and its length.
- **`line_of_sight`** — tiles and contents along the line between two points. Does **not** adjudicate vision — the DM decides.
- **`tiles_in_range`** — all tiles within N steps, optionally filtered (e.g., "entities only" or "terrain type = lava").

## Token Economics

A 50x50 map stored as JSON might be several KB, but the DM rarely needs the whole thing. The typical interaction pattern:

1. DM calls `map` with `view` centered on the action — costs ~200-300 tokens for a 15x15 viewport.
2. DM calls spatial queries as needed — each returns a short factual answer.
3. DM narrates to the player using the results.

The full map JSON sits on disk. Only viewports and query results enter the context window.
