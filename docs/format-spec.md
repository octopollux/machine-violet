# Campaign Format Specification

Version: **1**

This document defines the on-disk format for a Machine Violet campaign. It is the canonical reference for any tool that reads, writes, repairs, exports, or migrates campaign state. A conforming implementation can construct a campaign directory from scratch that loads and plays in the engine.

---

## 1. Conventions

### 1.1 Null Semantics

Every field in every file follows a three-state model:

| State | JSON representation | Markdown front matter | Meaning |
|---|---|---|---|
| **Present** | The value itself | `**Key:** value` | Has data |
| **Explicitly empty** | `null` | `**Key:** <none>` | Assessed and intentionally blank |
| **Missing** | Key absent from object | No line for that key | Never set — may need repair |

An agentic repair prompt can say: *"An empty modeline looks like `<none>`. If you see no modeline data, it should be repaired."* The distinction between explicit-empty and missing is what makes this possible.

In TypeScript, these map to: value = present, `null` = explicit-empty, `undefined` = missing.

### 1.2 File Encoding

All text files are UTF-8 with LF line endings. JSON files use 2-space indentation (`JSON.stringify(data, null, 2)`). Markdown files end with a trailing newline.

### 1.3 Slugs

Entity slugs are kebab-case: lowercase ASCII, hyphens for spaces, no special characters. Example: `"Marta Voss"` → `marta-voss`. Slugs are used as filenames and directory names.

### 1.4 Wikilinks

Every entity mention in transcripts, changelogs, and campaign logs is a wikilink. Two syntaxes are valid:

- **Relative path:** `[Display Name](../characters/marta-voss.md)` — used in entity files (relative to the file's location).
- **Double-bracket:** `[[Marta Voss]]` — used in transcripts, campaign logs, and DM notes. Resolved against the entity tree at runtime.

Dead links (wikilinks to entities that don't have files yet) are valid. They represent entities that exist in fiction but haven't been detailed.

### 1.5 Versioning

`config.json` carries a `version` field (currently `1`). State files do not carry independent version fields — they are versioned implicitly by the campaign format version in `config.json`. A tool reading a campaign should check `config.json.version` first.

---

## 2. Directory Structure

A campaign is a single directory with this layout:

```
campaign-root/
├── config.json                         # Campaign configuration (§3)
├── pending-operation.json              # Crash recovery breadcrumb (§4.11)
│
├── campaign/
│   ├── log.json                        # Structured campaign log (§5.1)
│   ├── compendium.json                 # Player-facing knowledge base (§5.2)
│   ├── dm-notes.md                     # Campaign-wide DM scratchpad (plain markdown)
│   ├── player-notes.md                 # Campaign-wide player notes (plain markdown)
│   ├── scenes/
│   │   └── NNN-slug/                   # Per-scene directory (§5.3)
│   │       ├── transcript.md           # Scene transcript (§5.4)
│   │       ├── summary.md             # Scene summary (plain markdown)
│   │       └── dm-notes.md            # Scene-specific DM notes (plain markdown)
│   └── session-recaps/
│       ├── session-NNN.md              # Bullet-list session recap
│       └── session-NNN-narrative.md    # Narrative recap (player-facing)
│
├── characters/                         # Character entities (§6)
│   ├── character-slug.md
│   └── party.md                        # Party composition file
├── locations/                          # Location entities (§6)
│   └── location-slug/
│       ├── index.md                    # Location entity file
│       └── map-id.json                # Map data (§4.3)
├── factions/                           # Faction entities (§6)
│   └── faction-slug.md
├── lore/                               # Lore entities (§6)
│   └── lore-slug.md
├── items/                              # Item entities (§6)
│   └── item-slug.md
├── rules/                              # Rule cards (copied from system templates)
│   └── rule-card-slug.md
│
├── state/                              # Runtime state (§4)
│   ├── combat.json
│   ├── clocks.json
│   ├── maps.json
│   ├── decks.json
│   ├── objectives.json
│   ├── scene.json
│   ├── conversation.json
│   ├── ui.json
│   ├── usage.json
│   ├── resources.json
│   └── display-log.md
│
└── .git/                               # Local git repository (isomorphic-git)
```

### 2.1 Naming Conventions

- **Scene directories:** 3-digit zero-padded number + hyphen + slug. Example: `001-tavern-meeting`.
- **Session recaps:** `session-` + 3-digit zero-padded number. Example: `session-001.md`.
- **Locations** are the only entities that use subdirectories (to co-locate map JSON files). All other entity types are flat files in their category directory.
- **Entity filenames** are slugified entity names. No filename prefixes for subtypes — type lives in front matter, not the filename.

### 2.2 Required vs Optional Files

A minimal valid campaign requires:
- `config.json`
- `characters/` with at least one character file
- All directories from the scaffold (may be empty)

Everything else is created during play.

---

## 3. Campaign Configuration (`config.json`)

```jsonc
{
  // Manifest
  "version": 1,                           // Required. Campaign format version.
  "createdAt": "2026-04-07T12:00:00Z",    // ISO 8601 timestamp.

  // Identity
  "name": "The Sunken Citadel",           // Required. Campaign display name.
  "system": "dnd-5e",                     // System slug (matches systems/<slug>/).
  "genre": "dark fantasy",                // Freeform genre tag.
  "mood": "gritty",                       // Freeform mood tag.
  "difficulty": "hard",                   // Freeform difficulty tag.
  "premise": "A frontier town...",        // Player-visible campaign premise.
  "campaign_detail": "Hidden DM notes...",// DM-only campaign instructions.

  // DM personality
  "dm_personality": {
    "name": "The Warden",                 // Required. Display name.
    "description": "Terse and foreboding",// Optional. Setup-time description.
    "prompt_fragment": "You are...",      // Required. Injected into DM system prompt.
    "detail": "Hidden tuning notes..."    // DM-only detail block.
  },

  // Players
  "players": [
    {
      "name": "Alex",                     // Required. Player display name.
      "character": "Marta Voss",          // Required. Character name.
      "type": "human",                    // "human" | "ai"
      "model": "haiku",                   // AI player model ("haiku" | "sonnet"). AI only.
      "personality": "Cautious ranger...",// AI personality prompt. AI only.
      "color": "#4488ff",                 // Hex color for player UI elements.
      "age_group": "adult"                // "child" | "teenager" | "adult"
    }
  ],

  // Combat configuration
  "combat": {
    "initiative_method": "d20_dex",       // "d20_dex" | "card_draw" | "fiction_first" | "custom"
    "initiative_deck": null,              // Deck ID for card_draw method.
    "round_structure": "individual",      // "individual" | "side" | "popcorn"
    "surprise_rules": true                // Whether surprise mechanics apply.
  },

  // Context window management
  "context": {
    "retention_exchanges": 100,           // Max exchanges retained in conversation window.
    "max_conversation_tokens": 0,         // 0 = disabled (recommended). Token cap for conversation.
    "campaign_log_budget": 15000          // Token budget for campaign log in DM prefix.
  },

  // Git recovery
  "recovery": {
    "auto_commit_interval": 3,            // Exchanges between auto-commits.
    "max_commits": 100,                   // Pruning threshold.
    "enable_git": true                    // Whether git snapshots are active.
  },

  // Choice presentation
  "choices": {
    "campaign_default": "often",          // "none" | "rarely" | "often" | "always"
    "player_overrides": {}                // Per-player overrides, keyed by player name.
  },

  // Display
  "calendar_display_format": null         // Freeform format hint for calendar display.
}
```

All fields except `version`, `name`, `dm_personality` (with `name` and `prompt_fragment`), `players` (at least one, with `name`, `character`, and `type`), `combat`, `context`, `recovery`, and `choices` are optional.

---

## 4. State Files (`state/`)

State files are JSON, written by the engine's `StatePersister` with fire-and-forget semantics. Each file is independently loadable — a missing file means that subsystem has never been activated. All state files use 2-space indented JSON except `conversation.json` (compact, no indentation — it can be large).

### 4.1 Combat (`state/combat.json`)

```jsonc
{
  "active": false,                        // Whether combat is in progress.
  "order": [                              // Initiative order. Empty when not in combat.
    {
      "id": "Marta Voss",                // Combatant display name.
      "initiative": 18,                   // Rolled/set initiative value.
      "type": "pc"                        // "pc" | "npc" | "ai_pc"
    }
  ],
  "round": 0,                            // Current round number (0 when inactive).
  "currentTurn": 0                        // Index into order array.
}
```

### 4.2 Clocks (`state/clocks.json`)

```jsonc
{
  "calendar": {
    "current": 0,                         // Current time in minutes from epoch.
    "epoch": "The story begins.",         // Narrative label for time zero.
    "display_format": "fantasy",          // Freeform format hint.
    "alarms": [
      {
        "id": "merchant-caravan",         // Unique alarm ID.
        "fires_at": 1440,                // Minute threshold.
        "message": "The merchant caravan arrives at the east gate.",
        "repeating": 10080               // Optional. Repeat interval in minutes.
      }
    ]
  },
  "combat": {
    "current": 0,                         // Current combat round.
    "active": false,                      // Whether combat clock is ticking.
    "alarms": []                          // Same alarm structure as calendar.
  }
}
```

### 4.3 Maps (`state/maps.json`)

All maps, keyed by map ID. Also written individually to `locations/<slug>/<mapId>.json`.

```jsonc
{
  "tavern-main-floor": {
    "id": "tavern-main-floor",
    "gridType": "square",                 // "square" | "hex"
    "bounds": { "width": 20, "height": 15 },
    "defaultTerrain": "stone-floor",
    "regions": [                          // Rectangular terrain regions. Later entries win overlaps.
      { "x1": 0, "y1": 0, "x2": 5, "y2": 3, "terrain": "bar-counter" }
    ],
    "terrain": {                          // Sparse per-cell overrides. Key: "x,y".
      "10,7": "firepit"
    },
    "entities": {                         // Sparse per-cell entity lists. Key: "x,y".
      "3,2": [
        { "id": "Bartender Hilde", "type": "npc", "notes": "Polishing glasses" }
      ]
    },
    "annotations": {                      // Sparse per-cell text. Key: "x,y".
      "10,7": "A warm fire crackles here."
    },
    "links": [                            // Connections to other maps (floors, areas).
      {
        "coord": "19,7",                  // Source coordinate on this map.
        "target": "tavern-upstairs",      // Target map ID.
        "targetCoord": "0,7",            // Landing coordinate on target map.
        "description": "Stairs leading up"
      }
    ],
    "meta": {                             // Freeform key-value metadata.
      "lighting": "dim candlelight"
    }
  }
}
```

**Terrain resolution order:** Cell override (`terrain[coord]`) → last matching region → `defaultTerrain`.

**Coordinate format:** `"x,y"` string keys. Origin is top-left `(0,0)`.

### 4.4 Decks (`state/decks.json`)

```jsonc
{
  "decks": {
    "initiative-deck": {
      "id": "initiative-deck",
      "drawPile": [
        { "value": "Jack", "suit": "Spades", "raw": "JS" }
      ],
      "discardPile": [],
      "hands": {                          // Keyed by holder name.
        "Marta Voss": [
          { "value": "Ace", "suit": "Hearts", "raw": "AH" }
        ]
      },
      "template": "standard52"           // "standard52" | "tarot" | "custom"
    }
  }
}
```

### 4.5 Objectives (`state/objectives.json`)

```jsonc
{
  "objectives": {
    "1": {
      "id": "1",
      "title": "Find the missing scout",
      "description": "Ranger Eldan went into the Thornwood three days ago and hasn't returned.",
      "status": "active",                 // "active" | "completed" | "failed" | "abandoned"
      "created_scene": 2,
      "resolved_scene": null              // null until resolved. Explicit-empty = resolved with no scene.
    }
  },
  "next_id": 2,                           // Auto-incrementing ID counter.
  "current_scene": 5                      // Kept in sync by scene manager.
}
```

### 4.6 Scene (`state/scene.json`)

```jsonc
{
  "precis": "The party is negotiating with the goblin chief...",
  "openThreads": "Who poisoned the well? Where is the stolen relic?",
  "npcIntents": "Chief Grukk is stalling for time while scouts flank.",
  "playerReads": [
    {
      "engagement": "high",              // "high" | "moderate" | "low"
      "focus": ["combat", "npc-dialogue"],
      "tone": "aggressive",
      "pacing": "pushing_forward",        // "exploratory" | "pushing_forward" | "hesitant"
      "offScript": false
    }
  ],
  "activePlayerIndex": 0                  // Index into config.players array.
}
```

`openThreads`, `npcIntents`, and `precis` follow null semantics: `null` = explicitly cleared (e.g., after scene transition), absent = never assessed.

### 4.7 Conversation (`state/conversation.json`)

Array of exchanges. Compact JSON (no indentation) since this file can grow large.

```jsonc
[
  {
    "user": { /* NormalizedMessage */ },
    "assistant": { /* NormalizedMessage */ },
    "toolResults": [ /* NormalizedMessage[] */ ],
    "estimatedTokens": 1250
  }
]
```

`NormalizedMessage` is the provider-abstracted message format (role + content blocks). This file is an opaque runtime cache — it is cleared on scene transitions and is not meaningful for export or repair. Its schema is coupled to the provider abstraction layer.

### 4.8 UI (`state/ui.json`)

```jsonc
{
  "styleName": "gothic",                  // Theme name (matches a .theme asset file).
  "variant": "exploration",              // "exploration" | "combat" | "ooc" | "levelup" | "dev"
  "keyColor": "#8844cc",                 // Hex color for accent elements. null = use theme default.
  "modelines": {                          // Key-value pairs shown in the modeline bar.
    "left": "The Sunken Citadel",
    "center": "Scene 5",
    "right": "Day 3"
  }
}
```

`modelines` follows null semantics: `null` = explicitly no modelines, absent = never configured.

### 4.9 Usage (`state/usage.json`)

```jsonc
{
  "byTier": {
    "small": { "input": 45000, "output": 8000, "cached": 12000 },
    "medium": { "input": 20000, "output": 5000, "cached": 8000 },
    "large": { "input": 150000, "output": 30000, "cached": 90000 }
  },
  "tokens": {                             // Aggregate totals.
    "input_tokens": 215000,
    "output_tokens": 43000,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 110000
  },
  "apiCalls": 87
}
```

Informational only. Not used by game logic.

### 4.10 Resources (`state/resources.json`)

```jsonc
{
  "displayResources": {                   // Which resource keys to show per character.
    "Marta Voss": ["HP", "Spell Slots"]
  },
  "resourceValues": {                     // Current resource values per character.
    "Marta Voss": {
      "HP": "28/35",
      "Spell Slots": "2/4"
    }
  }
}
```

Resource keys are freeform strings that correspond to labels on character sheets. Values are freeform display strings (not parsed as numbers).

### 4.11 Pending Operation (`pending-operation.json`)

Lives at the campaign root (not in `state/`). Present only during an in-progress scene transition or session end. If this file exists and is non-empty when the engine starts, it resumes the interrupted operation.

```jsonc
{
  "type": "scene_transition",             // "scene_transition" | "session_end"
  "step": "subagent_updates",            // Current step in the cascade (see below).
  "sceneNumber": 5,
  "title": "Escape from the Goblin Caves",
  "timeAdvance": 120                      // Optional. Calendar minutes to advance.
}
```

**Step order** (each step is idempotent and safe to re-run):
1. `finalize_transcript` — write transcript to scene directory
2. `subagent_updates` — campaign log, changelog, compendium (parallel)
3. `advance_calendar` — tick the calendar clock
4. `check_alarms` — fire any triggered alarms
5. `validate` — run campaign validation
6. `reset_precis` — clear scene state for the new scene
7. `prune_context` — clear conversation window
8. `checkpoint` — git commit
9. `done` — clear this file

### 4.12 Display Log (`state/display-log.md`)

Append-only rolling markdown log of human-readable engine activity. Each line is a rendered narrative or system event. Never cleared — grows for the lifetime of the campaign. Used to populate backscroll on session resume and for transcript export.

This file is plain text (one line per entry). Not structured — not suitable for programmatic parsing.

---

## 5. Campaign Files

### 5.1 Campaign Log (`campaign/log.json`)

Structured scene-by-scene record of campaign events. Player-safe (no DM secrets).

```jsonc
{
  "campaignName": "The Sunken Citadel",
  "entries": [
    {
      "sceneNumber": 1,
      "title": "Tavern Meeting",
      "full": "- [[Marta Voss]] met [[Old Brennan]] at the [[Rusty Anchor]]\n- Learned about the missing scouts",
      "mini": "Party formed at the Rusty Anchor; learned about missing scouts"
    }
  ]
}
```

- `full`: Bullet-list summary with wikilinks. May be multi-line (joined with `\n`).
- `mini`: Dense one-liner, max 128 characters. Preserves only critical wikilinks.
- Entries are ordered by `sceneNumber` (ascending).

### 5.2 Compendium (`campaign/compendium.json`)

Player-facing knowledge base. Updated by a Haiku subagent at scene transitions.

```jsonc
{
  "version": 1,
  "lastUpdatedScene": 5,
  "characters": [
    {
      "name": "Old Brennan",
      "slug": "old-brennan",
      "aliases": ["The Hermit"],          // Optional alternative names.
      "summary": "A reclusive hermit who knows the Thornwood's secrets.",
      "firstScene": 1,
      "lastScene": 5,
      "related": ["thornwood", "missing-scouts"]
    }
  ],
  "places": [],
  "items": [],
  "storyline": [],
  "lore": [],
  "objectives": []
}
```

**Categories:** `characters`, `places`, `items`, `storyline`, `lore`, `objectives`.

All category arrays use the same `CompendiumEntry` structure. `related` contains slugs of related entries across any category.

### 5.3 Scene Directories

Scene directories live under `campaign/scenes/` and are named `NNN-slug` where NNN is the 3-digit zero-padded scene number and slug is a kebab-case summary.

Contents:
- `transcript.md` — Finalized scene transcript (§5.4). Always present after scene transition.
- `summary.md` — Scene summary generated by the summarizer subagent. Plain markdown with wikilinks.
- `dm-notes.md` — Optional DM-only notes for the scene.

### 5.4 Transcript Format

Transcripts are plain markdown with a heading and alternating player/DM turns:

```markdown
# Scene 1

**[Marta Voss]** I approach the bar and ask about the missing scouts.

**DM:** The bartender sets down her rag and fixes you with a look. "You're the third person to ask this week," [[Hilde]] says. "The [[Thornwood]] swallows people whole."

> `roll_dice`: 2d20kh1+5 → [18, 7] → 23 (Insight check)

**[Marta Voss]** I study her face for any sign she's hiding something.

**DM:** Her eyes flicker to the back door. She's telling the truth — but she's afraid of something she hasn't mentioned.
```

**Conventions:**
- Player input: `**[Character Name]** text`
- DM narration: `**DM:** text`
- Tool results: `> \`tool-name\`: result text`
- All entity names are wikilinked (double-bracket form `[[Name]]`).
- Scene heading is `# Scene N` (unpadded number).

### 5.5 Session Recaps

Two files per session under `campaign/session-recaps/`:

- `session-NNN.md` — Terse bullet-list recap used in the DM's context prefix on resume.
- `session-NNN-narrative.md` — Narrative "previously on..." recap shown to the player.

Both are generated by Haiku subagents. NNN is 3-digit zero-padded.

---

## 6. Entity Files

All entity files are markdown with a consistent structure. Entity types: `character`, `location`, `faction`, `lore`, `item`.

### 6.1 File Structure

```markdown
# Entity Name

**Type:** Character
**Player:** [Alex](../players/alex.md)
**Location:** [[Rusty Anchor]]
**Color:** #4488ff
**Display Resources:** HP, Spell Slots, Lay on Hands
**Additional Names:** Marta, The Scarred One
**Theme:** gothic
**Key Color:** #8844cc
**Disposition:** friendly

Body text — free-form markdown describing the entity.
Can include any markdown: paragraphs, lists, headings (##), etc.

## Stats
STR 14  DEX 12  CON 16  INT 10  WIS 13  CHA 8

## Inventory
- Longsword (+1)
- Chain mail
- Explorer's pack

## Changelog
- **Scene 001**: First appearance at the [[Rusty Anchor]]
- **Scene 003**: Promoted to full character sheet
- **Scene 007**: Acquired the [[Moonblade]] from [[Old Brennan]]
```

### 6.2 Front Matter

Front matter lines appear immediately after the H1 heading and before the body. Each line has the format:

```
**Key Name:** Value
```

**Parsing:** The key is normalized to `lowercase_with_underscores` for storage. On serialization, keys are converted back to `Title Case With Spaces`.

**Known keys:**

| Storage key | Display key | Used by | Example value |
|---|---|---|---|
| `type` | Type | All entities | `Character`, `Location`, `Faction`, `Lore`, `Item` |
| `player` | Player | Characters | `[Alex](../players/alex.md)` |
| `class` | Class | Characters | `Paladin 5` |
| `location` | Location | Characters, items | `[[Rusty Anchor]]` |
| `color` | Color | Characters | `#4488ff` (hex) |
| `disposition` | Disposition | Characters (NPCs) | `friendly`, `hostile`, `neutral` |
| `additional_names` | Additional Names | All entities | Comma-separated aliases |
| `display_resources` | Display Resources | Characters | Comma-separated resource keys |
| `theme` | Theme | Locations | Theme name to auto-apply |
| `key_color` | Key Color | Locations | `#8844cc` (hex) |
| `sheet_status` | Sheet Status | Characters | `minimal`, `full` |
| `hp` | HP | Characters | `28/35` |
| `ac` | AC | Characters | `16` |
| `xp` | XP | Characters | `1200` |

The `_title` key is internal (extracted from the H1 heading) and never serialized.

**Explicit-empty:** `**Key:** <none>` parses to `null`, distinguishing "no value on purpose" from "key not present."

**Value types:** All front matter values are strings on disk. Comma-separated values (like `display_resources` and `additional_names`) are stored as the raw string; consumers split on `, ` as needed.

### 6.3 Body Sections

The body is free-form markdown. Character sheets commonly use these `##` sections (order is convention, not enforced):

- `## Relationships`
- `## Stats`
- `## Skills`
- `## Inventory`
- `## Conditions`
- `## Notes`

Other sections are valid. The body is not parsed by the engine except for the `## Changelog` section.

### 6.4 Changelog

The `## Changelog` section is append-only. Each entry is a single `- ` line:

```
- **Scene NNN**: Description with [[wikilinks]]
```

- Scene numbers are 3-digit zero-padded in changelog entries.
- Wikilinks in changelog entries are mandatory for entity references.
- Entries are in chronological order (oldest first).
- The `## Changelog` section is always last. If absent, it is created on first append.
- The changelog subagent generates entries; `appendChangelog()` in the engine handles formatting and insertion.

### 6.5 Entity Lifecycle

Entities exist on a spectrum from minimal to fully detailed:

1. **Dead link** — A `[[wikilink]]` in a transcript with no corresponding file. Valid; represents an entity that exists in fiction but hasn't been detailed.
2. **Minimal entity** — Title + type + optional one-line description. Created by the Scribe tool.
3. **Significant entity** — Has body text, relationships, notes. Grows organically through play.
4. **Full character sheet** — Has stats, skills, inventory, conditions. Created by `promote_character`.

### 6.6 Special Entity Files

- **`characters/party.md`** — Party composition and dynamics. Updated by the Scribe. No front matter keys beyond `_title`.
- **`campaign/dm-notes.md`** — Campaign-wide DM scratchpad. Plain markdown, read/written by `dm_notes` tool.
- **`campaign/player-notes.md`** — Campaign-wide player notes. Plain markdown.

### 6.7 Location Subdirectories

Locations use subdirectories to co-locate map data:

```
locations/
└── rusty-anchor/
    ├── index.md          # The location entity file
    ├── main-floor.json   # Map data (same schema as state/maps.json values)
    └── cellar.json       # Another floor/area
```

Map JSON files in location directories use the same `MapData` schema documented in §4.3. These are also present in `state/maps.json` at runtime (the authoritative copy during play).

---

## 7. Machine-Scope Files

Some data lives outside the campaign directory, at the machine-scope root. On Windows this is `~/Documents/.machine-violet/`; on macOS/Linux it's `~/.machine-violet/`.

```
~/.machine-violet/
├── players/
│   └── player-slug.md          # Player profile (persists across campaigns)
└── systems/
    └── system-slug/
        └── rule-card.md        # Processed/user-customized rule card
```

### 7.1 Player Files

Player files are markdown entity files with the same front matter format. They track cross-campaign player preferences:

- Age group, content boundaries
- Play style observations
- Meta-observations from the DM

### 7.2 System Rule Cards

Rule cards use XML-directive format within markdown:

```xml
<system name="D&D 5th Edition" version="SRD 5.2" dice="d20, d12, d10, d8, d6, d4">

<core_mechanic>
d20 + modifier vs target number (DC or AC).
</core_mechanic>

<character_creation>
1. Choose race → ability score bonuses
2. Choose class → hit dice, proficiencies, features
...
</character_creation>

</system>
```

At campaign creation, the selected system's rule card is copied to the campaign's `rules/` directory. The lookup order is:
1. User-processed: `~/.machine-violet/systems/<slug>/rule-card.md`
2. Bundled: `systems/<slug>/rule-card.md` (repo root)

---

## 8. Git Repository

The campaign directory contains a local git repository managed by isomorphic-git. It is never pushed to a remote.

### 8.1 Commit Types

| Type | Message format | Trigger |
|---|---|---|
| `auto` | `auto: exchanges 45-47` | Every N exchanges (configurable) |
| `scene` | `scene: Escape from the Goblin Caves` | Scene transition checkpoint |
| `session` | `session: end session 3` | Session end |
| `character` | `character: Marta Voss promoted` | Character promotion/update |
| `checkpoint` | `checkpoint: manual save` | Explicit save request |

### 8.2 Author

All commits use author `machine-violet <machine-violet@local>`.

### 8.3 Pre-commit Hook

The engine's `StatePersister.flush()` is called before every commit to ensure all pending JSON writes are on disk.

---

## 9. Known Deviations from Spec (Bugs)

This section documents known code behaviors that deviate from this spec. Each is a bug to be fixed.

1. **State file null semantics:** State files do not yet distinguish `null` from absent keys. This spec defines the target behavior; implementation should follow.
