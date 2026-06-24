# Campaign Format Specification

Version: **1**

This document defines the on-disk format for a Machine Violet campaign. It is the canonical reference for any tool that reads, writes, repairs, exports, or migrates campaign state. A conforming implementation can construct a campaign directory from scratch that loads and plays in the engine.

Cross-references: [state-atlas.md](state-atlas.md) (runtime types, ownership, persistence map, invariants).

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
  "campaign_detail": "Hidden DM notes...",// DM-only instructions. For seed-built campaigns this is the
                                          // ASSEMBLED detail: fork-invariant base + selected fork-option
                                          // detail, flattened at finalize (§10.6), plus any setup-agent
                                          // detail appended on top. No unchosen branches.
  "fork_selections": {                    // Optional. forkId → optionId — which seed variant was resolved
    "starting-faction": "iron-circle"     // at setup. First-class record; drives scoped materialization. Absent for custom campaigns.
  },
  "campaign_scope": "few-sessions",       // Optional. "one-shot" | "few-sessions" | "grand-campaign" | "open-ended". Shapes DM pacing.
  "setup_handoff": "Player wants to...",  // Optional. Postcard from the setup agent for the DM's first-turn priming. Injected once.
  "opening_scene": "Open with the PC...",  // Optional. One-sentence opening-scene directive the setup agent composes at finalize — where/how the DM opens turn 1
                                          // (a character-grounded beat, not the main objective). Injected once into first-turn priming alongside setup_handoff.

  // DM personality
  "dm_personality": {
    "name": "The Warden",                 // Required. Display name.
    "description": "Terse and foreboding",// Optional. Setup-time description.
    "prompt_fragment": "You are...",      // Required. Injected into DM system prompt.
    "detail": "Hidden tuning notes..."    // DM-only detail block.
  },

  // Players — the PC roster. Normally written once at creation, but the
  // `swap_pc` tool may rewrite a slot's `character`/`color`/`name` in-session
  // (a PC handoff) and persists config.json so it survives reload.
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
    "auto_commit_interval": 1,            // Exchanges between auto-commits. 1 = commit every turn (default).
    "max_commits": 100,                   // Pruning threshold.
    "enable_git": true                    // Whether git snapshots are active.
  },

  // Choice presentation
  "choices": {
    "campaign_default": "never",          // "never" | "rarely" | "sometimes" | "often" | "always" — 5-step probability. "none" is still accepted as a legacy alias for "never".
    "player_overrides": {}                // Per-player overrides (same enum), keyed by character name.
  },

  // Display
  "calendar_display_format": null,        // Freeform format hint for calendar display.

  // DM prose-length tuning
  "dm_turn_length_pct": 80                // Optional. Multiplier (in percent) applied to the
                                          // narrative-row count reported to the DM in each turn's
                                          // [length] hint. 80 = tell the DM the page is 20% shorter
                                          // than it really is, nudging tighter prose. Overlong-response
                                          // tracking still uses the real row count. Range 50–150 in
                                          // 5% steps; default 80. Editable from the in-game Campaign
                                          // Settings modal (Esc → Settings).

  // Image generation consent
  "image_generation": "on"                // Optional. "on" | "off" | "unset".
                                          // Player consent for inline image generation. Set by the
                                          // setup agent after an explicit yes/no question. "on" and
                                          // "off" reflect a recorded choice; "unset" (or absent, for
                                          // pre-feature campaigns) means the question hasn't been
                                          // asked yet. The engine gates image gen on BOTH provider
                                          // capability AND this preference: it is enabled only when
                                          // the active provider/model exposes image generation and
                                          // the preference is not "off" — so "unset"/absent is
                                          // treated as opt-in once the capability is present. When
                                          // the effective provider/model can't generate images, this
                                          // field is silently ignored. Reversible at any time from the
                                          // in-game Campaign Settings modal's "Image Generation"
                                          // toggle (Esc → Settings; persisted via PATCH /settings).

  // Mechanics handling (light systems only)
  "mechanics_mode": "dm-managed"          // Optional. "dm-managed" | "player-facing".
                                          // How the active LIGHT system's mechanics are surfaced. The
                                          // setup agent asks the player only when a light/ultra-light
                                          // system is chosen; "dm-managed" = the DM runs the rules
                                          // silently behind the fiction, "player-facing" = mechanics
                                          // are named at the table. Absent for crunchy systems
                                          // (implicitly player-facing) and systemless campaigns.
                                          // When a light system runs without this field (older
                                          // saves), the DM prefix falls back to "dm-managed".
                                          // Read by the DM prefix (the "## Game System" block +
                                          // volatile [stats] tail); see rules-systems.md.
}
```

All fields except `version`, `name`, `dm_personality` (with `name` and `prompt_fragment`), `players` (at least one, with `name`, `character`, and `type`), `combat`, `context`, `recovery`, and `choices` are optional.

---

## 4. State Files (`state/`)

State files are JSON, written by the engine's `StatePersister` (`src/context/state-persistence.ts`) with fire-and-forget semantics. Each file is independently loadable — a missing file means that subsystem has never been activated. All state files use 2-space indented JSON except `conversation.json` (compact, no indentation — it can be large).

Runtime types, ownership, and mutation rules are documented in [state-atlas.md §2 Persistence Map](state-atlas.md#2-persistence-map).

### 4.1 Combat (`state/combat.json`)

**Runtime type:** `CombatState` (`shared/types/combat.ts`)

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

**Runtime type:** `ClocksState` (`shared/types/clocks.ts`)

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

**Runtime type:** `Record<string, MapData>` (`shared/types/maps.ts`)

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

**Runtime type:** `DecksState` (`shared/types/cards.ts`)

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

**Runtime type:** `ObjectivesState` (`shared/types/objectives.ts`)

```jsonc
{
  "objectives": {
    "1": {
      "id": "1",
      "title": "Find the missing scout",
      "description": "Ranger Eldan went into the Thornwood three days ago and hasn't returned.",
      "status": "active",                 // "active" | "completed" | "failed" | "abandoned"
      "created_scene": 2
      // "resolved_scene": 5              // Absent until resolved. Present = scene number when resolved.
    }
  },
  "next_id": 2,                           // Auto-incrementing ID counter.
  "current_scene": 5                      // Kept in sync by scene manager.
}
```

### 4.6 Scene (`state/scene.json`)

**Runtime type:** `PersistedSceneState` (`engine/src/context/state-persistence.ts`)

```jsonc
{
  "precis": "The party is negotiating with the goblin chief...",
  "openThreads": "Who poisoned the well? Where is the stolen relic?",
  "npcIntents": "Chief Grukk is stalling for time while scouts flank.",
  "playerReads": [
    {
      "focus": ["combat", "npc-dialogue"],
      "tone": "aggressive",
      "offScript": false
    }
  ],
  "activePlayerIndex": 0                  // Index into config.players array.
}
```

`openThreads`, `npcIntents`, and `precis` follow null semantics: `null` = explicitly cleared (e.g., after scene transition), absent = never assessed.

### 4.7 Conversation (`state/conversation.json`)

**Runtime type:** `ConversationExchange[]` (`engine/src/context/conversation.ts`)

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

**Runtime type:** `PersistedUIState` (`engine/src/context/state-persistence.ts`)

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

**Runtime type:** `TokenBreakdown` (`shared/types/engine.ts`)

```jsonc
{
  "byTier": {
    "small": { "input": 45000, "output": 8000, "cached": 12000 },
    "medium": { "input": 20000, "output": 5000, "cached": 8000 },
    "large": { "input": 150000, "output": 30000, "cached": 90000 }
  },
  "tokens": {                             // Aggregate totals (camelCase, not Anthropic API snake_case).
    "inputTokens": 215000,
    "outputTokens": 43000,
    "cacheCreationTokens": 0,
    "cacheReadTokens": 110000
  },
  "apiCalls": 87
}
```

Informational only. Not used by game logic.

### 4.10 Resources (`state/resources.json`)

**Runtime type:** `PersistedResourceState` (`engine/src/context/state-persistence.ts`)

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

**Runtime type:** `PendingOperation` (`engine/src/agents/scene-manager.ts`)

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

Every `slug` must equal `slugify(name)` (see [`packages/shared/src/utils/slug.ts`](../packages/shared/src/utils/slug.ts)) — leading articles `the`/`a`/`an` are stripped, so "The City" gets the slug `city`, not `the-city`. Slugs in `related[]` follow the same rule. The engine canonicalizes compendiums on read and after each subagent update, so older saves with article-retaining slugs migrate transparently.

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
| `placeholder` | Placeholder | Any | `true` — flags a stub entity that the Scribe should rename + flesh out (e.g. the bootstrap `Starting Location`). Removed once the entity has a real name and content. |

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
| `auto` | `auto: I draw my sword and charge the troll.` (player's last message, single-line, truncated to 72 chars; `auto: exchanges` for synthetic system turns) | Every N exchanges (configurable) |
| `scene` | `scene: Escape from the Goblin Caves` | Scene transition checkpoint |
| `session` | `session: end session 3` | Session end |
| `character` | `character: Marta Voss promoted` | Character promotion/update |
| `checkpoint` | `checkpoint: manual save` | Explicit save request |

### 8.2 Author

All commits use author `machine-violet <machine-violet@local>`.

### 8.3 Pre-commit Hook

The engine's `StatePersister.flush()` is called before every commit to ensure all pending JSON writes are on disk.

---

## 10. World Files (`.mvworld`)

**Runtime type:** `WorldFile` (`shared/types/world.ts`)

World files are portable campaign seeds or world exports. A single `.mvworld` file contains world metadata and optional inline content. Campaign seeds and exported worlds share the same format — seeds are sparse world files with only identity and detail fields.

### 10.1 Discovery

The engine loads worlds from two directories:
- **Bundled**: `assetDir("worlds")` — shipped with the binary (copied from `worlds/` at build time)
- **User**: `~/.machine-violet/worlds/` — player-created or imported

Bundled seeds are validated strictly (malformed files fail the build). User worlds are validated leniently (bad files are skipped).

### 10.2 Schema

```jsonc
{
  // --- Header (required) ---
  "format": "machine-violet-world",     // Must be this exact string.
  "version": 1,                          // Schema version.

  // --- Identity (required) ---
  "name": "The Shattered Crown",
  "summary": "A kingdom's heir is dead. Three factions claim the throne.",
  "genres": ["fantasy"],

  // --- Optional campaign config ---
  "description": "...",                  // Short description alongside the summary.
  "system": "dnd-5e",                   // Game system slug.
  "mood": "gritty",
  "difficulty": "hard",
  "campaign_scope": "open-ended",        // Optional. Bakes campaign length into the seed; setup agent skips the length question.
  "image_style": "NoirCinema",           // Optional. A .mvstyle stem (prompts/include/Image/). Styles the chargen portrait + in-game art (§10.8).
  "dm_personality": { "name": "...", "prompt_fragment": "..." },
  "calendar_display_format": "fantasy",

  // --- DM-only content ---
  "detail": "The throne sits empty...",   // Fork-INVARIANT base prose (§10.6). DM-only, assembled in code.

  // --- Setup-agent-only content ---
  "setup_detail": "<!--include:Pacing.EndlessCampaigns-->",  // Surfaced to the setup agent (includes expanded); NEVER reaches the DM (§10.7).

  // --- Forks: named decision points, resolved at setup (§10.6) ---
  "forks": [
    {
      "id": "starting-faction",          // Stable kebab-case id. Referenced by config.fork_selections.
      "label": "Your starting faction",
      "chooser": "player",               // "player" (presented) | "agent" (setup agent rolls/chooses; DM-only)
      "options": [
        { "id": "iron-circle", "name": "The Iron Circle", "description": "Start entangled with the military..." },
        { "id": "gilded-compact", "name": "The Gilded Compact", "description": "Start among the merchants..." }
      ]
    },
    {
      "id": "the-secret",
      "label": "The throne's secret",
      "chooser": "agent",                // The setup agent decides (often by rolling the dice tool).
      "options": [
        { "id": "heir-lives", "name": "The heir lives", "description": "...", "detail": "DM-only prose spliced into campaign_detail iff selected." },
        { "id": "heir-dead", "name": "The heir is truly dead", "description": "...", "detail": "..." }
      ]
    }
  ],
  // "suboptions": [...]                  // DEPRECATED legacy player-choice groups; folded into `forks` on load.

  // --- Inline content (optional — empty for seeds, rich for exports) ---
  "entities": {                          // Keyed by category, then slug.
    "characters": {},
    "locations": {},
    "factions": {},
    "items": {},
    "lore": {}
  },
  "maps": {},                            // Same schema as state/maps.json values.
  "rules": {},                           // Rule card content keyed by slug.
  "calendar": {                          // World time (no alarms).
    "current": 14400,
    "epoch": "The founding of Valdris",
    "display_format": "fantasy"
  },
  "_tokens": {                           // Derived. Stamped by `npm run tokens` (refreshed at pre-push). Not hand-authored; not read by the engine. See §10.9.
    "detail": 2278, "setup_detail": 296, "forks": 524, "total": 3726
  }
}
```

### 10.3 Minimal seed

A campaign seed is a world file with only the identity and DM-only fields:

```json
{
  "format": "machine-violet-world",
  "version": 1,
  "name": "Hollowdeep",
  "summary": "A mining town's deepest shaft broke into something old.",
  "genres": ["fantasy", "horror"]
}
```

### 10.4 Setup agent integration

The setup agent receives world summaries (name, summary, genres, slug) in its system prompt. It uses the `load_world` tool to fetch a world's **forks** and config hints by slug (§10.6) — player forks to present, agent forks for it to decide (rolling the `roll_dice` tool). It resolves every fork and reports the choices in `finalize_setup.fork_selections`.

The setup agent only ever sees this **thin slice** — the forks (labels/options/ids) and the suggested `system`/`mood`/`difficulty`/`campaign_scope`. It does **not** receive the DM-only premise prose: `campaign_detail`'s seed base is assembled in code at finalize from the seed's base + the selected branches (§10.6). The agent *may*, however, supply its own `campaign_detail` even on a seeded campaign — it is **appended** after the assembled base (used to record a setup-time DM directive, e.g. a chosen visual-style include; a colliding `<Tag>` block in the agent's addition wins at DM-prompt time). A world's rich inline content (`entities`, `maps`, `rules`, `calendar`) is likewise never loaded into the agent's context; it is materialized in code at build time (§10.5).

At finalize the setup agent also composes a one-sentence **opening-scene directive** (`finalize_setup.opening_scene` → `config.opening_scene`) telling the DM where/how to open turn 1. This is deliberately the setup agent's job, not the DM's: the DM's "you are a DM" framing biases it toward dropping the player straight onto the main objective, whereas a good campaign usually opens on a character-grounded beat. A seed can nudge the chosen opening by putting a "begins in…" hint in `setup_detail` (the setup-agent-only channel, §10.7); the agent honors it if present, or **suppress the declaration entirely** with `<!--include:OpeningScene.DMHandled-->` in `setup_detail` (the agent then passes an empty `opening_scene` and the DM opens from the campaign's own brief — used by seeds like `cold-open` whose `detail` already scripts turn 1). The directive is injected once into the DM's first-turn priming ([game-initialization.md](game-initialization.md#step-4-handoff-to-the-dm)) and never reaches the cached DM prefix.

### 10.5 Importing rich worlds (materialization)

When a campaign is built from a world that carries inline content, `buildCampaignWorld` → `materializeWorldContent` ([`packages/engine/src/agents/world-builder.ts`](../packages/engine/src/agents/world-builder.ts)) re-loads the world by slug (`SetupResult.worldSlug`, set only when the setup agent passed an explicit `world_slug` to `finalize_setup`) and writes its content directly to disk:

| World field | On-disk target |
|---|---|
| `entities.characters` | `characters/<slug>.md` — **NPCs only**; any `type: PC` entity is skipped (the PC comes from chargen) |
| `entities.locations` | `locations/<slug>/index.md` |
| `entities.factions` | `factions/<slug>.md` |
| `entities.lore` | `lore/<slug>.md` |
| `entities.items` | `items/<slug>.md` |
| `rules` | `rules/<slug>.md` (verbatim) |
| `maps` | `state/maps.json` (authoritative runtime store) |
| `calendar` | `state/clocks.json` (calendar time + epoch; idle clocks, no alarms) |

Entity filenames come from the canonical `campaignPaths` helpers (which slugify the entity title), so a correctly authored seed round-trips.

**Fork-scoped entities.** An entity may carry `appliesWhen: { fork, option }` (§10.6). It is materialized only if the campaign's `fork_selections` resolved that fork to that option — so a branch-specific NPC/location (e.g. a data-hall that exists only in the sci-fi wrapper) stays out of campaigns that took a different branch. Entities without `appliesWhen` are universal and always materialized.

**Deliberately not seeded:** `campaign/compendium.json` (the *player-facing* knowledge base — must start empty so the player discovers the world; a pre-filled compendium spoils novelty and misinforms the DM about player knowledge), the PC character sheet (chargen), and `campaign/log.json` entries (a seed carries no episodic record). The bootstrap `starting-location` placeholder is still written; the DM/Scribe renames it to the real opening locale (§6.6, scribe prompt).

Authoring a `.mvworld` from a played campaign is a manual, brain-in-the-loop task — see the `build-mvworld` skill ([`.claude/skills/build-mvworld/SKILL.md`](../.claude/skills/build-mvworld/SKILL.md)) and the worked example [`worlds/the-salt-wedding.mvworld`](../worlds/the-salt-wedding.mvworld).

### 10.6 Forks (seed variants)

A single seed often encodes **many possible campaigns** — a "genre wrapper", a secret "crucial question", a starting faction. These are **forks**: named decision points, each with named **options** (branches).

**Forks resolve entirely at setup.** Player-facing forks (`chooser: "player"`) are presented to the player; agent-decided forks (`chooser: "agent"`) are rolled or chosen by the setup agent (DM-only — the genre wrapper, secret rolls). By the time the DM runs, every fork is collapsed to a single selected option; **the unchosen branches never enter the DM's context.** There are no deferred/play-time forks — the DM is never handed a "pick the whole campaign variant" decision.

| Concept | Where | Shape |
|---|---|---|
| Fork definitions | `.mvworld` `forks[]` | `{ id, label, chooser, prompt?, options[] }` |
| Option | `forks[].options[]` | `{ id, name, description, detail? }` |
| The selection (hard data) | `config.json` `fork_selections` | `{ forkId: optionId }` |

**`detail` splits in two.** The seed's top-level `detail` is the **fork-invariant base** — prose true for every variant. Each option's `detail` is the **branch-specific** prose, spliced into the campaign's `campaign_detail` only when that option is selected. The campaign's final detail is `assembleCampaignDetail(detail, normalizeForks(world), fork_selections)` ([`packages/engine/src/config/world-forks.ts`](../packages/engine/src/config/world-forks.ts)), flattened once at finalize.

The legacy `suboptions` shape (player-facing only) is **folded into `forks`** (`chooser: "player"`) by `normalizeForks` for any consumer that calls it, so older/user-authored files keep working; new seeds author `forks` directly.

> **Status (staged rollout).** Live now: the `forks` / `fork_selections` format and `appliesWhen` scoping; the `world-forks.ts` helpers (`normalizeForks`, `assembleCampaignDetail`); setup-agent consumption — `load_world` surfaces forks, the agent resolves them (rolling agent forks via `roll_dice`), and `handleFinalize` assembles `campaign_detail` from the seed base + selected branches and persists `fork_selections`; and fork-scoped materialization (§10.5 gates `appliesWhen` entities on the selection). Still pending: migrating the bundled seeds from prose forks to structured `forks` (until a seed is migrated, its prose forks remain in its `detail` base and assemble through unchanged — no regression).

### 10.7 The three channels out of a seed

Seed content reaches three different audiences, and a field belongs to exactly one channel:

| Channel | Field(s) | How it flows | Sees it |
|---|---|---|---|
| **DM** | `detail` + selected fork-option `detail` | code: `assembleCampaignDetail` → `config.campaign_detail` → DM prompt (includes expanded at DM-prompt time) | DM only |
| **Setup agent** | `forks` (labels/options), config hints, and **`setup_detail`** | `load_world` → `renderWorldForAgent` (includes expanded here) | setup agent only |
| **Player** | player-fork option `name`/`description`, `suboptions` | the setup agent presents them via `present_choices` | player |

`setup_detail` is the **setup-agent-only** channel. The setup agent acts on it (e.g. presents a scope/pacing variant) but it is **never assembled into `campaign_detail`** — the exclusion is by omission (`assembleCampaignDetail` only reads `detail` + selected option `detail`), so it is structurally impossible for it to reach the DM. This is the home for content that is neither DM-facing nor directly player-facing: scope/rhythm presentation (e.g. `<!--include:Pacing.EndlessCampaigns-->`), the opening-scene opt-out (`<!--include:OpeningScene.DMHandled-->` — the agent declares no opening and the DM opens instead), chargen hints, alternate hooks the agent should weigh. **Setup-only includes (notably the `Pacing.*` scope blocks) belong here, not in `detail`** — in `detail` they would expand into the DM's context and make it re-ask the scope question on turn 1.

### 10.8 Visual style (`image_style`)

`image_style` names one visual style for the seed — the **stem of a `.mvstyle` variant** in [`packages/engine/src/prompts/include/Image/`](../packages/engine/src/prompts/include/Image/) (e.g. `"NoirCinema"`, `"CinematicFilm"`, `"StreetCam"`). It is a single, human-graded, one-style-per-seed pairing (see [docs/visual-style-authoring.md](visual-style-authoring.md)). **When authoring a new seed, default `image_style` to `PainterlyGame`** — a painterly render that suits any genre — and defer the specific pick to the eyeball/grade pass. It drives two things, both at setup:

A stem may point at either a **single catalog style** (one backtick-fenced `# Style` directive) or a per-seed **composite** — a `.mvstyle` named after the seed whose `# Style` lists a labeled *menu*: a **default** look plus situational variants (outdoor night, dark crisis, a surveillance cam, a player-requested image, …) the DM chooses between per the file's `# Direction`. Composites are authored **default-first**.

1. **The chargen portrait.** The setup agent's character reference sheet is rendered in this style. The engine stamps the style's **default render directive** onto the portrait prompt — for a plain style that's its lone `# Style` sentence; for a composite it's the *default* look (the first backtick-fenced span), never the whole situational menu, whose extra variants and caption clauses would fight the reference-sheet framing. When a seed declares no `image_style` — or the campaign is fully custom — the fallback is `CinematicFilm` (a placeholder until per-seed defaults are graded).
2. **In-game art.** At finalize, `<!--include:Image.<style>-->` is appended to the campaign's `campaign_detail`. At DM-prompt time it resolves into an `<Image>` block that **overrides the bare `<Image>` default** — the `campaign_detail` override slot outranks the `dm-directives` slot where the default lives. A setup-agent-appended `<Image>` (a setup-time style choice) is placed *after* the seed's, so it still wins the in-slot collision.

The value is validated against a real `.mvstyle` at finalize (`resolveImageStyleLine`): a bogus stem or missing file emits **no** include rather than bricking every DM turn with an unresolved-include throw — the campaign just stays on the default look. The setup agent may also override the seed's style (clobbering seed data is a feature — §10.6).

### 10.9 Token stamps (`_tokens` / `tokens:`)

Prompt-content files carry a **derived, at-a-glance estimate** of their own token weight, stamped by `npm run tokens` ([`scripts/content-tokens.ts`](../scripts/content-tokens.ts)):

- `.mvworld` → a `_tokens` object: `{ detail, setup_detail, forks, total }`. `detail` is the per-turn DM-context cost (the channel that rides in the cached prefix every turn); `total` sums every string in the file.
- `.mvdm` → a `_tokens` object: `{ prompt_fragment, detail, total }`.
- `.mvstyle` → a scalar `tokens:` in frontmatter: the **emitted** weight (`# Direction` + `# Style` only; `# Notes`/`# Example` are authoring-only and don't reach the image model).

The count is an **estimate** — OpenAI's `o200k_base` encoding (GPT-4o/5) via `js-tiktoken`: local, deterministic, offline. The DM may run on Claude or GPT and tokenizers differ by ~10–15%, but the encoding is fixed, so counts are consistent and rank seed weight reliably. The field is **derived bookkeeping**: hand-editing it is pointless (it's overwritten), and the engine never reads it. Counts come from the content fields only (the stamp itself is excluded), so stamping is idempotent.

`npm run tokens` prints a sorted report and touches nothing; `--write` stamps the files. The **pre-push** hook runs `--write --commit`: if any stamp was stale it commits just the stamped files and aborts the push (re-run it to include the commit), so what lands on a branch always has current stamps. In steady state it's a no-op; during a content sprint it fires often.

---

## 11. Known Deviations from Spec (Bugs)

This section documents known code behaviors that deviate from this spec. Each is a bug to be fixed.

1. ~~**State file null semantics:**~~ Resolved. `Persisted*` types use `T | null` for explicit-empty; serialization and hydration distinguish `null` from absent keys.
