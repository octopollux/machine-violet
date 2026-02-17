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
| `create_map` | `(id, gridType, bounds, defaultTerrain)` | Initialize a new map JSON file. |
| `define_region` | `(map, bounds, terrain)` | Set terrain for a rectangular area. |
| `import_entities` | `(map, entities[])` | Batch-place multiple entities. |

---

## Randomization Tools → [randomization.md](randomization.md)

### Primitives

| Tool | Tier | Caller | Signature | Returns |
|---|---|---|---|---|
| `roll_dice` | T1 | DM, subagents | `({ expression, reason, display, claimed_result? })` | Individual die values, kept dice, modifier, total. Mechanistic — no interpretation. |
| `deck` | T1 | DM, subagents | `({ deck, operation, count?, from? })` | Card(s) drawn/peeked, remaining count. Operations: create, shuffle, draw, return, peek, state. |

### Resolution

| Tool | Tier | Caller | Signature | Returns |
|---|---|---|---|---|
| `resolve_action` | T2 (Haiku) | DM | `({ actor, action, target, conditions })` | Summary, rolls breakdown, target stat, details, state changes. The DM's workhorse for mechanical resolution. |

`resolve_action` is a subagent wrapper — it spawns a Haiku subagent that reads character sheets and rules, calls `roll_dice`, evaluates, and returns a structured result. Player-facing when it needs input ("Use Divine Smite?"), silent for NPC actions.

---

## Clock Tools → [clocks-and-alarms.md](clocks-and-alarms.md)

All T1. All called by DM.

| Tool | Signature | Effect |
|---|---|---|
| `set_alarm` | `({ clock, in, message, repeating? })` | Set an alarm on calendar or combat clock. Returns alarm ID + fire time. |
| `clear_alarm` | `({ id })` | Remove an alarm by ID. |
| `next_round` | `({})` | Advance combat round counter. Checks and fires combat alarms. Returns round number + any fired alarms. |
| `check_clocks` | `({})` | Read current state of both clocks and pending alarms. |

---

## Combat / Initiative Tools → [multiplayer-and-initiative.md](multiplayer-and-initiative.md)

All T1 (initiative rolling may delegate to T2 for complex systems). Called by DM.

| Tool | Signature | Effect |
|---|---|---|
| `start_combat` | `({ combatants[] })` | Roll initiative, set turn order, activate combat clock and UI variant. Returns sorted order + round 1. |
| `modify_initiative` | `({ action, combatant, position? })` | Mid-combat changes: add, remove, move, delay a combatant. |
| `end_combat` | `({})` | Clear initiative, reset combat clock, clear combat alarms, return to free player switching. |

---

## Scene / Session Tools → [overview.md](overview.md), [context-management.md](context-management.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `scene_transition` | T1 + T2 | DM | `({ title, time_advance })` | Cascade: finalize transcript, write campaign log entry (Haiku), update entity changelogs (Haiku), advance calendar clock, check alarms, update precis, prune context, checkpoint state. |
| `session_end` | T1 + T2 | DM | `({})` | Final scene transition + Haiku writes session recap. Saves state. |
| `session_resume` | T1 + T2 | Engine | `({})` | Load campaign state, build cached prefix, display "Previously on..." recap modal, start DM with fresh context. |
| `context_refresh` | T1 + T2 | DM | `({})` | Mid-scene reorientation: regenerate scene precis from transcript on disk, re-read active state, refresh cached prefix. Conversation retained as-is. |

---

## Entity Tools → [entity-filesystem.md](entity-filesystem.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `promote_character` | T2 (Haiku) | DM | `({ name, file, level, context })` | Expand a character from minimal to full sheet. Haiku reads rules + existing notes, generates appropriate stats, writes/updates file. |

---

## TUI Tools → [tui-design.md](tui-design.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `update_modeline` | T1 | DM | `({ text })` | Set modeline content. Freeform text string. |
| `set_ui_style` | T1 | DM, Engine | `({ style?, variant? })` | Switch frame style variant (combat/exploration/ooc/levelup) or change base style. |
| `set_display_resources` | T1 | DM, Setup | `({ character, resources[] })` | Update which resource keys appear in the top frame for a character. |
| `present_choices` | T1 + T2 | DM, Engine | `({ prompt?, choices[]? })` | Show choice modal. No params = Haiku subagent generates options. Explicit params = DM's choices. |
| `present_roll` | T1 | DM | `({ result, label })` | Display a dice roll as a dramatic modal. |
| `show_character_sheet` | T1 | DM, Player | `({ character })` | Open character sheet modal. |

---

## OOC / Mode Tools → [dm-prompt.md](dm-prompt.md), [overview.md](overview.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `enter_ooc` | T1 | DM | `({})` | Hand conversation to the OOC subagent (Sonnet). TUI switches to OOC style. DM receives terse summary when OOC ends. |

---

## Error Recovery Tools → [error-recovery.md](error-recovery.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `rollback` | T1 | OOC agent | `({ target })` | Restore campaign state to a git commit. Target can be a commit hash, scene label, "last", or "exchanges_ago:N". Triggers `session_resume` after. |

---

## Summary

| Domain | Tool count | Tiers |
|---|---|---|
| Map queries | 6 | T1 |
| Map mutations | 5 | T1 |
| Map bulk setup | 3 | T1 |
| Randomization | 3 | T1, T2 |
| Clocks | 4 | T1 |
| Combat | 3 | T1 |
| Scene/Session | 4 | T1+T2 |
| Entity | 1 | T2 |
| TUI | 6 | T1, T1+T2 |
| OOC/Mode | 1 | T1 |
| Error recovery | 1 | T1 |
| **Total** | **37** | |

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
