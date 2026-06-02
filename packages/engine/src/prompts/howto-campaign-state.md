# How campaign state is laid out (catch-all)

This is the fallback reference for changing campaign state when there's **no
dedicated tool** for what you want. It maps where everything lives on disk and,
crucially, **which tool edits which thing**. For the common handoffs there are
purpose-built playbooks — reach for those first:

- Swapping the player character → `howto_swap_pc`
- Changing the DM's voice → `howto_swap_dm_personality`

If one of those fits, use it. This guide is for everything else.

## What edits what

| You want to change | Use |
|---|---|
| A character / location / faction / lore / item | `entity` (read / create / update / delete / list) |
| The PC roster (who's played) | `swap_pc` (see `howto_swap_pc`) |
| The DM's personality | `swap_dm_personality` (see `howto_swap_dm_personality`) |
| Campaign or scene DM notes | `dm_notes` |
| Combat / initiative | `start_combat`, `advance_turn`, `modify_initiative`, `end_combat` |
| Clocks, calendar, alarms | `alarm`, `time` |
| Maps & tokens | `map`, `map_entity`, `map_query` |
| Card decks | `deck` |
| Objectives / quests | `manage_objectives` |
| Top-frame resources | `set_display_resources`, `set_resource_values` |
| Modeline / theme | `update_modeline`, `style_scene` |
| A new scene / session boundary | `scene_transition`, `session_end` |

If a change maps to one of these, the tool owns the file and its persistence —
don't hand-edit the underlying JSON.

**No tool fits?** Most `state/*.json` files and the `campaign/` logs are owned by
the engine and have no free-form editor on the DM/OOC surface. Arbitrary file
edits (raw JSON surgery, repairing a corrupted file, bulk fixes) live in **Dev
mode**, which adds `read_file` / `write_file` / `set_game_state` / `raw_entity_io`
plus `validate_campaign` and `repair_state`. If you're on the DM/OOC surface and
nothing above can make the change, say so and point the user at Dev mode rather
than inventing a workaround.

## The layout

```
campaign-root/
├── config.json              # Campaign config (§ below). Edited in-play ONLY via swap_pc / swap_dm_personality.
├── pending-operation.json   # Crash-recovery breadcrumb. Engine-owned.
├── campaign/
│   ├── log.json             # Structured campaign log (scene/session entries)
│   ├── compendium.json      # Player-facing knowledge base
│   ├── dm-notes.md          # Campaign-wide DM scratchpad → dm_notes
│   ├── player-notes.md      # Campaign-wide player notes
│   ├── scenes/NNN-slug/     # Per-scene: transcript.md, summary.md, dm-notes.md
│   └── session-recaps/      # session-NNN.md (+ -narrative.md, player-facing)
├── characters/              # Character entities → entity (type: character)
│   ├── <slug>.md            #   PC/NPC role is the **Type:** field (PC|NPC|character)
│   └── party.md             #   Party roster (Members list of [[wikilinks]])
├── locations/<slug>/index.md  # Location entities (subdir co-locates map JSON) → entity (type: location)
├── factions/<slug>.md       # → entity (type: faction)
├── lore/<slug>.md           # → entity (type: lore)
├── items/<slug>.md          # → entity (type: item)
├── rules/<slug>.md          # System rule cards (copied from the system template)
└── state/                   # Runtime state — each file owned by a tool (table below)
```

### `config.json`

The campaign manifest: `name`, `system`, `genre`/`mood`/`difficulty`, `premise`,
`campaign_detail` (DM-only), `dm_personality`, `players[]`, `combat`, `context`,
`recovery`, `choices`. Written at creation and otherwise read-only in play — the
only in-session mutations are `players[]` (via `swap_pc`) and `dm_personality`
(via `swap_dm_personality`), both of which persist the file.

### `state/` files and their owners

| File | Holds | Owned by |
|---|---|---|
| `combat.json` | initiative order, round | combat tools |
| `clocks.json` | calendar + combat clocks, alarms | `alarm`, `time` |
| `maps.json` | map grids & tokens | map tools |
| `decks.json` | card decks | `deck` |
| `objectives.json` | quests/goals | `manage_objectives` |
| `scene.json` | precis, open threads, `activePlayerIndex` | scene/precis updates, `switch_player`, `swap_pc` |
| `conversation.json` | retained exchange history | engine |
| `ui.json` | theme, key color, per-character modelines | `update_modeline`, `style_scene` |
| `resources.json` | per-character display keys + values | `set_display_resources`, `set_resource_values` |
| `usage.json` | token/cost accounting | engine |
| `display-log.md` | rolling human-readable log | engine (append-only) |

## Conventions

- **Slugs:** entity filenames are the slugified display name (`Marta Voss` →
  `marta-voss.md`). Locations are the only entities in subdirectories.
- **Wikilinks:** `[[entity-slug]]` (or markdown `[Display](../type/slug.md)`),
  tracked bidirectionally. The `entity` delete/rename tools keep them coherent.
- **Entity `**Type:**`:** the category for non-characters (location/faction/…),
  but on a character sheet it's the *role* (PC | NPC | character). The functional
  PC is `config.players`, not this field.

## Runtime gotchas

- **`config.dm_personality` is read live every DM turn** — a `swap_dm_personality`
  takes effect on the next turn, no reload.
- **PC character sheets are snapshotted at session start** (`pcSheets`) and not
  refreshed mid-session. Sheet edits via `entity` are correct on disk and visible
  in the conversation, but the cached prompt copy stays stale until the next
  session load. The same holds for the rules appendix.
- **Persistence is per-tool and write-through.** A tool that owns a file persists
  it when it mutates. There's no global "save" — if you bypass the owning tool,
  the change may not survive a reload.

## The exhaustive spec

For full JSON shapes, null semantics, versioning, transcript/recap formats, git
layout, and migration rules, the canonical reference is `docs/format-spec.md`
(maintainer-facing). This guide is the in-play operator's summary of it.
