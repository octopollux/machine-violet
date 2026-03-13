# Tools Catalog

Every tool specified across the design docs, organized by domain. Each entry includes the tool's tier, who calls it, and a link to the source design doc.

**Tier key**: T1 = Code (zero tokens), T2 = Haiku/Sonnet subagent, T3 = Opus DM.

**Caller key**: DM = the Opus DM agent calls this tool. Engine = the app code calls this automatically. OOC = the OOC subagent calls this. Setup = the setup agent calls this.

---

## Map Tools → [map-system.md](map-system.md)

All T1. All called by DM (or setup agent during init).

### Queries

| Tool | Signature | Returns |
|---|---|---|
| `view_area` | `(map, center, radius)` | Text grid + legend of the area around a point. The DM's primary spatial read. |
| `distance` | `(map, from, to)` | Tile count between two coordinates, respecting grid type. |
| `path_between` | `(map, from, to, options?)` | Shortest path + length. Options: terrain costs, impassable tiles. |
| `line_of_sight` | `(map, from, to)` | List of tiles and contents along the line. Does NOT adjudicate vision — DM decides. |
| `tiles_in_range` | `(map, center, range, filter?)` | All tiles within N steps, optionally filtered (entities only, terrain type, etc.). |
| `find_nearest` | `(map, from, type)` | Nearest entity or terrain of a given type. Returns coordinate + distance. |

### Mutations

| Tool | Signature | Effect |
|---|---|---|
| `place_entity` | `(map, coord, entity)` | Add an entity to a tile. |
| `move_entity` | `(map, entity_id, to)` | Relocate an entity. Updates coordinates. |
| `remove_entity` | `(map, entity_id)` | Remove an entity from the map entirely. |
| `set_terrain` | `(map, coord_or_region, terrain)` | Update terrain at a point or define a new region. |
| `annotate` | `(map, coord, text)` | Add or update a freeform annotation on a tile. |

### Bulk Setup

| Tool | Signature | Effect |
|---|---|---|
| `create_map` | `({ id, grid_type, width, height, default_terrain })` | Initialize a new map JSON file. |
| `define_region` | `({ map, x1, y1, x2, y2, terrain })` | Set terrain for a rectangular area. |
| `import_entities` | `(map, entities[])` | Batch-place multiple entities. |

---

## Randomization Tools → [randomization.md](randomization.md)

### Primitives

| Tool | Tier | Caller | Signature | Returns |
|---|---|---|---|---|
| `roll_dice` | T1 | DM, subagents | `({ expression, reason, display, claimed_result? })` | Individual die values, kept dice, modifier, total. Mechanistic — no interpretation. |
| `deck` | T1 | DM, subagents | `({ deck, operation, count?, from? })` | Card(s) drawn/peeked, remaining count. Operations: create, shuffle, draw, return, peek, state. |

### Resolution

The resolution subagent is not a registered tool — it's an internal subagent spawned by the engine. See [subagents-catalog.md](subagents-catalog.md) #1.

---

## Clock Tools → [clocks-and-alarms.md](clocks-and-alarms.md)

All T1. All called by DM.

| Tool | Signature | Effect |
|---|---|---|
| `set_alarm` | `({ clock, in, message, repeating? })` | Set an alarm on calendar or combat clock. Returns alarm ID + fire time. |
| `clear_alarm` | `({ id })` | Remove an alarm by ID. |
| `advance_calendar` | `({ minutes })` | Advance calendar clock by minutes. Fires triggered alarms. |
| `next_round` | `({})` | Advance combat round counter. Checks and fires combat alarms. Returns round number + any fired alarms. |
| `check_clocks` | `({})` | Read current state of both clocks and pending alarms. |

---

## Combat / Initiative Tools → [multiplayer-and-initiative.md](multiplayer-and-initiative.md)

All T1 (initiative rolling may delegate to T2 for complex systems). Called by DM.

| Tool | Signature | Effect |
|---|---|---|
| `start_combat` | `({ combatants[] })` | Roll initiative, set turn order, activate combat clock and UI variant. Returns sorted order + round 1. |
| `advance_turn` | `({})` | Advance to the next combatant's turn. Tracks individual turns within a round and auto-detects round boundaries. More granular than `next_round` (which advances the round-level combat clock). |
| `modify_initiative` | `({ action, combatant, position? })` | Mid-combat changes: add, remove, move, delay a combatant. |
| `end_combat` | `({})` | Clear initiative, reset combat clock, clear combat alarms, return to free player switching. |

---

## Scene / Session Tools → [overview.md](overview.md), [context-management.md](context-management.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `scene_transition` | T1 + T2 | DM | `({ title, time_advance })` | Cascade: finalize transcript, run subagent updates (campaign log + changelogs in parallel), advance calendar, check alarms, validate, reset precis, prune context, checkpoint. |
| `session_end` | T1 + T2 | DM | `({ title, time_advance? })` | Final scene transition + Haiku writes session recap. Saves state. |
| `context_refresh` | T1 + T2 | DM | `({})` | Mid-scene reorientation: regenerate scene precis from transcript on disk, re-read active state, refresh cached prefix. Conversation retained as-is. |

Note: Session resume is an engine operation, not a callable tool. It runs automatically on app launch when a campaign exists.

---

## Entity Tools → [entity-filesystem.md](entity-filesystem.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `scribe` | T2 (Haiku) | DM | `({ updates: [{ visibility, content }] })` | Batch entity creation/updates. Each update tagged `private` or `player-facing`. Spawns Haiku subagent with `list_entities`, `read_entity`, `write_entity` tools for autonomous entity file management. Handles deduplication, front matter, changelogs. |
| `search_campaign` | T2 (Haiku) | DM | `({ query })` | Search across all campaign files — entities, scene summaries, transcripts, session recaps, logs. Spawns Haiku subagent with `grep_campaign` and `read_campaign_file` tools. Returns terse excerpts with `[[wikilinks]]` and source references. |

Note: `promote_character` is not a registered tool — it's a subagent function called internally. See [subagents-catalog.md](subagents-catalog.md) #7.

---

## TUI Tools → [tui-design.md](tui-design.md)

TUI tools are **fire-and-forget**: their results drive engine/UI state but the DM doesn't need to reason about them. When ALL tool calls in a round are TUI tools, the agent loop bails out after dispatch — the tool_use/tool_result pair stays in conversation history but no acknowledgment API call is made. This saves one Opus round-trip per turn in the common case (narrate → update modeline → scribe). Mixed rounds (e.g. `roll_dice` + `update_modeline`) are NOT eligible for bail-out. See `TUI_TOOLS` in `src/agents/agent-session.ts`.

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `update_modeline` | T1 | DM | `({ text })` | Set modeline content. Freeform text string. |
| `style_scene` | T1 + T2 | DM, Engine | `({ description?, key_color?, variant?, save_to_location?, location? })` | Style UI to match scene mood. `description` triggers Haiku stylist subagent; `key_color` is direct. Optionally persist to location entity. |
| `set_display_resources` | T1 | DM, Setup | `({ character, resources[] })` | Update which resource keys appear in the top frame for a character. Also stores keys on `GameState.displayResources`. |
| `set_resource_values` | T1 | DM | `({ character, values: Record<string,string> })` | Set current values for a character's tracked resources (e.g. `{ "HP": "24/30" }`). Merges into `GameState.resourceValues`. |
| `present_choices` | T1 + T2 | DM, Engine | `({ prompt?, choices[]? })` | Show choice modal. No params = Haiku subagent generates options. Explicit params = DM's choices. |
| `present_roll` | T1 | DM | `({ expression, rolls, total, kept?, label? })` | Display a dice roll as a dramatic modal. |
| `show_character_sheet` | T1 | DM, Player | `({ character })` | Open character sheet modal. |

---

## Player Management Tools → [multiplayer-and-initiative.md](multiplayer-and-initiative.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `switch_player` | T1 | DM | `({ player })` | Switch the active player character during free play (outside combat). During combat, initiative controls turn order automatically. |

---

## Worldbuilding Tools

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `dm_notes` | T1 | DM | `({ action: "read" \| "write", notes? })` | Read or write persistent DM campaign notes. A private scratchpad for the DM to track plans, secrets, and reminders across scenes. |

---

## OOC / Mode Tools → [dm-prompt.md](dm-prompt.md), [overview.md](overview.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `enter_ooc` | T1 | DM | `({ reason })` | Hand conversation to the OOC subagent (Sonnet). TUI switches to OOC style. DM receives terse summary when OOC ends. Also player-accessible via game menu / `/ooc`; player-initiated summaries are injected as `<ooc_summary>` on the next DM turn. The OOC agent can auto-exit by emitting `<END_OOC />` or `<END_OOC>player action</END_OOC>` to forward in-character input. |

---

## Error Recovery Tools → [error-recovery.md](error-recovery.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `rollback` | T1 | OOC agent | `({ target })` | Restore campaign state to a git commit. Target can be a commit hash, scene label, "last", or "exchanges_ago:N". Triggers `session_resume` after. |

---

### Not tools (engine-managed, no DM call needed)

These are automatic behaviors, not callable tools:
- Activity line indicators (mapped from in-flight tool calls)
- Player switching (Tab hotkey outside initiative, automatic during initiative)
- Game menu (ESC key)
- Session recap modal (automatic on `session_resume`)
- Conversation retention / pruning (automatic per config)
- Auto-commit to git (automatic per config interval)
- Batch import polling (background timer)
- Choice auto-generation (engine triggers based on frequency config)
