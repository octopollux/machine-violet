# Tools Catalog

Every tool specified across the design docs, organized by domain. Each entry includes the tool's tier, who calls it, and a link to the source design doc.

**Tier key**: T1 = Code (zero tokens), T2 = Haiku/Sonnet subagent, T3 = Opus DM.

**Caller key**: DM = the Opus DM agent calls this tool. Engine = the app code calls this automatically. OOC = the OOC subagent calls this. Setup = the setup agent calls this.

---

## Map Tools → [map-system.md](map-system.md)

All T1. All called by DM (or setup agent during init).

| Tool | Operations | Description |
|---|---|---|
| `map` | `create`, `view`, `set_terrain`, `annotate`, `define_region` | The board itself: create maps, view as text grid, modify terrain and annotations. |
| `map_entity` | `place`, `move`, `remove`, `import`, `find_nearest` | Things on the map: place/move/remove tokens, batch import, find nearest entity or terrain. |
| `map_query` | `distance`, `path`, `line_of_sight`, `tiles_in_range` | Spatial questions between two points: distance, pathfinding, line of sight, area scan. |

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
| `resolve_turn` | T2 (Sonnet) | DM | `({ actor, action, targets?, conditions? })` | Structured result: narrative, dice rolls, state deltas (HP changes, conditions, resource spends). Engine auto-applies deltas to GameState. |

The DM calls `resolve_turn` for complex multi-step combat actions (Extra Attack, conditional abilities, reactions). For simple one-off checks outside combat, the DM uses `roll_dice` directly.

Requires active combat (`start_combat` must have been called). The persistent resolve session accumulates context across all turns — see [subagents-catalog.md](subagents-catalog.md) #1.

---

## Clock Tools → [clocks-and-alarms.md](clocks-and-alarms.md)

All T1. All called by DM.

| Tool | Operations | Effect |
|---|---|---|
| `alarm` | `set`, `clear`, `check` | Schedule future events on calendar or combat clock, clear by ID, or read current state of both clocks and pending alarms. |
| `time` | `advance`, `next_round` | Advance narrative time (calendar by minutes) or combat time (next round). Both fire triggered alarms. |

---

## Objectives Tools → [state-atlas.md](state-atlas.md) (schema, persistence), [format-spec.md](format-spec.md#45-objectives-stateobjectivesjson) (JSON schema)

All T1. Called by DM. Objectives are long-lifecycle, player-facing goals (quests, missions) that span scenes and surface in game context.

| Tool | Signature | Effect |
|---|---|---|
| `manage_objectives` | `({ action, id?, title?, description? })` | Manage long-term objectives. Actions: `create`, `update`, `complete`, `fail`, `abandon`, `list`. Pair with `alarm` for deadlines; for hidden DM goals use DM notes + alarms instead. |

### Lifecycle semantics

Every objective starts `active`. `create` requires both `title` and `description`. Terminal transitions, each of which sets `resolved_scene` to the current scene number:

- `complete` — the party achieved the goal (status → `completed`).
- `fail` — the goal became unachievable by circumstances (NPC died, time ran out, etc.) (status → `failed`).
- `abandon` — the DM deliberately drops the goal (retcon, narrative pivot) (status → `abandoned`).

Once an objective leaves `active`, it is immutable: `update`, `complete`, `fail`, and `abandon` all return an error if the objective is not currently `active`. `update` additionally requires at least one of `title` or `description`.

### Context injection

Active objectives (status `active`) are automatically included in the DM's cached-prefix "Active state" block on every turn — no tool call needed. The block is assembled by `buildActiveState()` in `agents/dm-prompt.ts`, which renders an `Objectives:` list; the entries are produced by `GameEngine.getActiveObjectives()` in `agents/game-engine.ts`, which filters to active-only and formats each as `obj-N: title — description`. Because the DM always has the current objectives in view, `list` is mainly useful for confirming IDs or reviewing already-resolved objectives.

### ID scheme

IDs are auto-assigned as `obj-1`, `obj-2`, … from the auto-incrementing `next_id` counter in `ObjectivesState`. IDs are stable across scenes and sessions. `current_scene` is kept in sync by the scene manager, not by the tool.

### Usage patterns

- **Player-facing quests and missions:** use `manage_objectives` — they surface in DM context automatically.
- **Hidden DM goals, secrets, internal tracking:** use DM notes (entity files) + `alarm`, not objectives. Objectives are always visible to the DM in context and represent goals the characters are actively pursuing.
- **Deadlines:** set an `alarm` when you create the objective; on alarm fire, call `fail` if the party hasn't completed it.

---

## Combat / Initiative Tools → [multiplayer-and-initiative.md](multiplayer-and-initiative.md)

All T1 (initiative rolling may delegate to T2 for complex systems). Called by DM.

| Tool | Signature | Effect |
|---|---|---|
| `start_combat` | `({ combatants[] })` | Roll initiative, set turn order, activate combat clock and UI variant. Returns sorted order + round 1. |
| `advance_turn` | `({})` | Advance to the next combatant's turn. Tracks individual turns within a round and auto-detects round boundaries. More granular than `time` next_round (which advances the round-level combat clock). |
| `modify_initiative` | `({ action, combatant, position? })` | Mid-combat changes: add, remove, move, delay a combatant. |
| `end_combat` | `({})` | Clear initiative, reset combat clock, clear combat alarms, return to free player switching. |

---

## Scene / Session Tools → [overview.md](overview.md), [context-management.md](context-management.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `scene_transition` | T1 + T2 | DM | `({ title, time_advance })` | Cascade: finalize transcript, run subagent updates (campaign log + changelogs in parallel), advance calendar, check alarms, validate, reset precis, prune context, checkpoint. |
| `session_end` | T1 + T2 | DM | `({ title, time_advance? })` | Final scene transition + Haiku writes session recap. Saves state. |
Note: Session resume is an engine operation, not a callable tool. It runs automatically on app launch when a campaign exists.

---

## Entity Tools → [entity-filesystem.md](entity-filesystem.md)

### Structured entity surface (DM + OOC + Dev)

T1 tools backed by the unified `EntityStore` (`packages/engine/src/entities/`), registered in the shared DM `ToolRegistry` so the DM, OOC, and Dev Mode all see them. The DM uses these for inspection (e.g. `entity("read", "characters", "kael")` to fetch a full record before narrating) and `scribe` for narrative writes; OOC and Dev additionally drive `create`/`update`/`delete` and the diagnostic tools when repairing the campaign.

| Tool | Operations | Effect |
|---|---|---|
| `entity` | `read`, `create`, `update`, `delete`, `list` | CRUD on file-backed entities (characters, locations, factions, lore, items). `read` returns frontmatter + body + inbound/outbound refs + schema + drift. `update` patch values of `null` delete a frontmatter key. `delete` reports inbound wikilinks that just became dead. |
| `describe_entity_type` | — | Returns the declared schema, observed drift, storage layout, conventions, and examples for an entity type. |
| `list_entity_types` | — | Lists all file-backed entity types with on-disk counts. |
| `validate_entity` | — | Validates a single entity: missing required fields, dead outbound wikilinks, schema conformance. |
| `find_schema_drift` | — | Lists frontmatter fields present on disk but not in the declared schema. Optionally scoped to one type. |
| `detect_orphans` | — | Lists file-backed entities with zero inbound wikilinks across the campaign. |

Dev Mode additionally exposes `raw_entity_io` (`read`/`write`/`delete` against a raw path) as a schema-bypass escape hatch for recovering from corrupted entity files. If you see `raw_entity_io` in a turn, it means the agent bypassed the structured surface.

### Narrative + search

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `scribe` | T2 (Haiku) | DM | `({ updates: [{ visibility, content }] })` | Batch entity creation/updates. Each update tagged `private` or `player-facing`. Spawns Haiku subagent with `list_entities`, `read_entity`, `write_entity`, and `rename_entity` tools for autonomous entity file management. Handles deduplication, front matter, changelogs, and placeholder rename. |
| `search_campaign` | T2 (Haiku) | DM | `({ query })` | Search across all campaign files — entities, scene summaries, transcripts, session recaps, logs. Spawns Haiku subagent with `grep_campaign` and `read_campaign_file` tools. Returns terse excerpts with `[[wikilinks]]` and source references. |
| `search_content` | T2 (Haiku) | DM | `({ query })` | Search the game system's ingested content library — monsters, spells, equipment, rules — by mechanical criteria (CR, level, type, rarity). Spawns a search subagent that queries faceted indexes and returns matching entities with key stats. Async-dispatched (the handler delegates to the game engine). Requires ingested system content. |

---

## TUI Tools → [tui-design.md](tui-design.md)

TUI tools are **fire-and-forget**: their results drive engine/UI state but the DM doesn't need to reason about them. Their `_tui` payloads are dispatched to the client as soon as the tool fires — non-deferred visual types (theme, modeline, resources) broadcast immediately; deferred types are collected for post-loop engine processing. Tool_use/tool_result pairs stay in conversation history and the agent loop continues normally; an earlier bail-out optimization on TUI-only rounds was removed (#266) because it prevented the DM from completing multi-step turns. See `TUI_TOOLS` in `src/agents/agent-loop.ts`.

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `update_modeline` | T1 | DM | `({ text, character? })` | Set modeline content for the named character. `character` defaults to the active character (`config.players[activePlayerIndex].character`). Freeform text string (supports inline `<b>`, `<i>`, `<u>`, `<color=#hex>` tags). |
| `promote_character` | T2 (Haiku) | DM | `({ character, context })` | Level up or update a character sheet. Queues a deferred `_tui` payload; after the DM turn completes, GameEngine spawns the character-promotion Haiku subagent to read the current sheet and rules, then write an updated sheet with changelog. If the sheet already carries `sheet_status: complete` (set by post-setup sheet building), the promotion is skipped and the flag is cleared. See [subagents-catalog.md](subagents-catalog.md) #7 and [entity-filesystem.md](entity-filesystem.md). |
| `style_scene` | T1 + T2 | DM, Engine | `({ description?, key_color?, variant?, save_to_location?, location? })` | Style UI to match scene mood. `description` triggers Haiku stylist subagent; `key_color` is direct. Optionally persist to location entity. |
| `set_display_resources` | T1 | DM, Setup | `({ character, resources[] })` | Update which resource keys appear in the top frame for a character. Also stores keys on `GameState.displayResources`. |
| `set_resource_values` | T1 | DM | `({ character, values: Record<string,string> })` | Set current values for a character's tracked resources (e.g. `{ "HP": "24/30" }`). Merges into `GameState.resourceValues`. |
| `present_choices` | T1 + T2 | DM, Engine | `({ prompt?, choices[]?, descriptions[]? })` | Show choice modal. No params = Haiku subagent generates options. Explicit params = DM's choices. Labels and descriptions support formatting tags; labels are bullet-prefixed. |
| `show_character_sheet` | T1 | OOC, Dev | `({ character })` | Open character sheet modal. Available in OOC and Dev Mode only. |

---

## Player Management Tools → [multiplayer-and-initiative.md](multiplayer-and-initiative.md)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `switch_player` | T1 | DM | `({ player })` | Pass the turn between characters **already in the roster** during free play (outside combat). During combat, initiative controls turn order automatically. Rejects a name not in `config.players` — use `swap_pc` to hand control to a new/existing character. |
| `swap_pc` | T1 | OOC, Dev | `({ character, replaces?, color?, player_name? })` | Reassign a roster slot to `character` and make it the active PC (a "PC swap" / handoff). The only tool that edits `config.players`, and it persists `config.json` so the new PC survives reload. Moves the pointer only — pair with `howto_swap_pc` to also fix sheets, party.md, resources, modeline, theme. |

---

## DM Personality Tools → [game-initialization.md](game-initialization.md#dm-personalities)

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `list_dm_personalities` | T1 | OOC, Dev | `({})` | List the personas available to swap to (bundled `.mvdm` presets + user additions), each with name + description, plus which is current. Borrows the setup agent's persona catalog (`loadAllPersonalities`) — the in-game agent doesn't otherwise have it in context. |
| `swap_dm_personality` | T1 | OOC, Dev | `({ name, prompt_fragment?, detail?, description? })` | Change the DM's narrative voice for the rest of the campaign. `name` matches a preset, or names a custom persona when `prompt_fragment` is supplied. The only tool that edits `config.dm_personality`; persists `config.json`. Read live each DM turn, so it takes effect next turn (no reload). Pair with `howto_swap_dm_personality` — the new voice must open with an in-fiction handoff. |

---

## How-To / Knowledge Tools ("skills")

`howto_*` tools take an empty arguments object and change nothing. They load a procedure into context — call one before a multi-step operation so you touch every piece of state.

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `howto_swap_pc` | T1 | OOC, Dev | `({})` | Returns the step-by-step playbook for swapping the player character with a new or existing character (roster, character sheets, party.md, resources, modeline, theme). Backed by `prompts/howto-swap-pc.md`. |
| `howto_swap_dm_personality` | T1 | OOC, Dev | `({})` | Returns the playbook for changing the DM personality mid-campaign (list → present → swap → required in-fiction voice handoff). Backed by `prompts/howto-swap-dm-personality.md`. |
| `howto_campaign_state` | T1 | OOC, Dev | `({})` | Catch-all: returns a map of campaign on-disk state and **which tool edits which thing** — the fallback when no dedicated tool obviously fits a change (routes to the right tool, or flags that the edit needs Dev mode). Distilled from [format-spec.md](format-spec.md); backed by `prompts/howto-campaign-state.md`. |

---

## Worldbuilding Tools

| Tool | Tier | Caller | Signature | Effect |
|---|---|---|---|---|
| `dm_notes` | T1 | DM | `({ action: "read" \| "write", notes? })` | Read or write persistent DM campaign notes. A private scratchpad for the DM to track plans, secrets, and reminders across scenes. |

---

## OOC / Mode Tools → [packages/engine/src/prompts/ooc-mode.md](../packages/engine/src/prompts/ooc-mode.md), [subagents-catalog.md](subagents-catalog.md)

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
