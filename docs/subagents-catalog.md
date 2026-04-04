# Subagents Catalog

Every subagent pattern specified across the design docs. A subagent is a nested Claude API conversation with its own context window — the parent's context is not polluted by the subagent's intermediate work.

**Visibility key**: Silent = DM-only, player never sees it. Player-facing = takes over the TUI temporarily.

---

## Runtime Subagents (during gameplay)

### 1. Resolve Session (Combat)

| Property | Value |
|---|---|
| **Model** | Sonnet (`medium` tier) |
| **Visibility** | Silent |
| **Trigger** | DM calls `resolve_turn` during active combat |
| **Lifecycle** | Created at `start_combat`, torn down at `end_combat` |
| **Source** | `src/agents/resolve-session.ts`, `src/prompts/resolve-session.md` |

**Persistent** combat resolution engine. Unlike fire-and-forget subagents, the resolve session accumulates context across all turns and rounds within a combat encounter. Messages are never pruned — Sonnet's 1M context window handles even marathon combats.

**Context**: System prompt with session identity + output format (BP1), rule card combat rules (BP2), all combatant stat blocks (BP3). Per-turn: combat state snapshot (round, initiative order, HP/conditions), action declaration.

**Tools**: `roll_dice`, `read_character_sheet`, `read_stat_block`, `query_rules`, `search_content` (fallback).

**Returns**: `ResolutionResult` with structured `StateDelta[]` (engine auto-applies HP/conditions/resources), `RollRecord[]`, and a narrative summary for the DM. Output format is XML (`<resolution>` block). Graceful fallback: if no XML block found, full text returned as narrative.

**Cost**: ~$0.20 for a 20-turn combat with prompt caching. Turns 2-20 read prior context at cache rate.

### 1b. Resolution Subagent (Legacy)

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent (NPC actions) or Player-facing (when player input needed) |
| **Trigger** | Internal (not directly DM-callable) |
| **Source doc** | [randomization.md](randomization.md) |

**Deprecated** — use Resolve Session for combat. This fire-and-forget subagent remains available for simple non-combat mechanical checks. No persistent context between calls.

**Returns**: Terse structured result — summary, rolls breakdown, state changes. ~20-50 tokens.

---

### 2. OOC Subagent

| Property | Value |
|---|---|
| **Model** | Sonnet |
| **Visibility** | Player-facing |
| **Trigger** | DM calls `enter_ooc`, or player via game menu / `/ooc` |
| **Source doc** | [dm-prompt.md](dm-prompt.md), [overview.md](overview.md) |

Sandboxed conversation for out-of-character discussion. Receives the DM's current context on entry. Handles rules questions, transcript searches, configuration changes, player corrections, validation requests, rollback.

**Context**: DM's cached prefix + recent conversation + OOC system prompt. Full access to campaign filesystem for lookups.

**Returns**: Terse summary to the DM when OOC ends — just what the DM needs to know to resume narrating. Does NOT return the full OOC conversation.

**Auto-exit**: The OOC agent can signal session end by emitting `<END_OOC />` (no player action) or `<END_OOC>player action text</END_OOC>` (with in-character text to forward). When a payload is provided, PlayingPhase auto-exits OOC and forwards the text to the DM as player input. This handles the case where the player drifts back to in-character mid-OOC. The player can also still exit manually via ESC.

**DM injection (player-initiated only)**: When OOC is entered from the game menu or `/ooc` slash command (not via DM's `enter_ooc` tool), accumulated summaries are injected as an `<ooc_summary>` XML tag prepended to the next player message. This persists in conversation history so the DM retains OOC context across turns. The DM-initiated path does not need this because the DM already sees the tool result.

**Tools available**: `read_file`, `find_references`, `scribe`, `promote_character`, `style_scene`, `set_display_resources`, `show_character_sheet`, `map`, `map_entity`, `map_query`, `alarm`, `get_commit_log`. Cannot call DM-only narrative tools.

**In scope**: Rules questions, character corrections, entity file reads, UI customization, dice rolls, map/clock queries, git history, rollback.

**Out of scope**: Bulk file operations, direct game state JSON patching, engine internals, campaign validation.

---

### 3. Choice Generation Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent (output displayed as modal) |
| **Trigger** | Engine auto-triggers based on frequency config, or DM calls `present_choices({})` with no params |
| **Source doc** | [tui-design.md](tui-design.md) |

Reads the last few exchanges of DM narration and generates 3-6 reasonable player options. Each choice is prepended with a Unicode bullet glyph (e.g. ◆, ▸, ◇) chosen to suit the scene's tone. Does not need to be brilliant — freeform input is always available as a fallback.

**Context**: Last 3-5 exchanges of DM narration + player input. ~500-1K tokens.

**Returns**: A prompt string and 3-6 bullet-prefixed choice strings. ~50-100 tokens.

---

### 4. Scene Summarizer

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | `scene_transition` cascade |
| **Source doc** | [context-management.md](context-management.md), [entity-filesystem.md](entity-filesystem.md) |

Writes the campaign log entry for a completed scene. Dense, wikilinked, one line per significant event. Must preserve ALL wikilinks from the transcript.

**Context**: The completed scene transcript + campaign log format instructions. Variable size.

**Returns**: Campaign log entry. ~50-150 tokens.

---

### 5. Precis Updater

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | When an exchange drops from the DM's conversation window |
| **Source doc** | [context-management.md](context-management.md) |

Appends a terse summary of the dropped exchange to the running scene precis. Keeps the DM oriented despite the short conversation window. Also extracts structured player engagement signals (see **PlayerRead** below).

**Context**: The dropped exchange + current precis. ~500-1K tokens.

**Returns**: Updated precis append (~20-50 tokens) + a `PlayerRead` JSON object with engagement signals.

**PlayerRead interface**: Extracted from every dropped exchange, providing lightweight sentiment/engagement tracking without a dedicated subagent call:

| Field | Type | Description |
|---|---|---|
| `engagement` | `"high" \| "moderate" \| "low"` | How invested the player seems (high = detailed/creative input) |
| `focus` | `string[]` | 1-3 tags for player focus (e.g. `"npc_interaction"`, `"combat"`, `"puzzle"`) |
| `tone` | `string` | Single word for the player's tone (e.g. `"playful"`, `"cautious"`) |
| `pacing` | `"exploratory" \| "pushing_forward" \| "hesitant"` | Whether the player is exploring, driving forward, or hesitant |
| `offScript` | `boolean` | `true` if the player typed a custom action rather than picking from offered choices |

The engine can use PlayerRead signals to adjust choice frequency, pacing hints in the DM prompt, or DM personality modulation.

---

### 5b. Scene Tracker

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | Every 4 player exchanges (configurable via `SCENE_TRACKER_CADENCE`) |
| **Source** | `src/agents/subagents/scene-tracker.ts`, `src/prompts/scene-tracker.md` |

Periodic scene housekeeping subagent. Currently maintains open narrative threads and NPC intentions from recent transcript. Designed to be extensible for future housekeeping tasks.

With `max_conversation_tokens` disabled (default), the precis updater never fires, so thread tracking needs an independent trigger. The scene tracker runs every N player exchanges, reading the last 6 transcript entries and the current thread/intent lists, then returning updated lists.

**Context**: Recent transcript tail (~6 entries) + current open threads + current NPC intents. ~200-300 tokens.

**Returns**: `SceneTrackerResult` with `openThreads` (comma-separated wikilinks) and optional `npcIntents` (semicolon-separated).

**Consumed by**: `buildScenePacing()` → `ScenePacingInjection` (advisory nudges about scene length and thread count).

---

### 6. Changelog Updater

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | `scene_transition` cascade |
| **Source doc** | [entity-filesystem.md](entity-filesystem.md) |

Scans the completed scene transcript. Identifies every entity meaningfully involved (not just mentioned). Appends a one-line changelog entry to each entity's file.

**Context**: Scene transcript + list of entity files. Variable size.

**Returns**: Changelog entries written directly to entity files. No return to DM.

---

### 6a. Compendium Updater

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | `scene_transition` cascade (parallel with summarizer + changelog) |
| **Source** | `src/agents/subagents/compendium-updater.ts`, `src/prompts/compendium-updater.md` |

Maintains the player-facing campaign compendium (`campaign/compendium.json`). Reads only the player-facing transcript (tool results filtered out), ensuring no DM secrets leak. Updates existing entries when new information is revealed; tracks identity shifts via `aliases` to prevent duplicates when NPCs are renamed.

**Context**: Current compendium JSON + player-facing scene transcript + entity alias context. ~2-5k tokens.

**Returns**: Updated compendium JSON written to disk. Also populates `DMSessionState.compendiumSummary` for the DM's "Player Knowledge" prefix section.

---

### 6b. Scribe Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | DM calls `scribe` tool |
| **Source doc** | [entity-filesystem.md](entity-filesystem.md) |

Autonomous entity file manager. Receives batched natural-language updates tagged `private` or `player-facing`. Has its own tools (`list_entities`, `read_entity`, `write_entity`) to manage the campaign filesystem. Handles entity creation, updates, front matter merging, changelog entries, and deduplication. Replaces the old `create_entity` / `update_entity` DM tools.

**Context**: The DM's update batch (natural language). ~200-500 tokens.

**Tools**: `list_entities(type)`, `read_entity(type, slug)`, `write_entity(mode, type, name, front_matter?, body?, changelog_entry?)`.

**Max tool rounds**: 8 (needs to list → read → write multiple entities).

**Returns**: Terse summary of entities created/updated. Usage stats accumulated to session total.

---

### 6c. Campaign Search Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | DM calls `search_campaign` tool |
| **Source** | `src/agents/subagents/search-campaign.ts` |

Agentic search across the entire campaign filesystem. Walks all campaign files into memory once, then uses code-backed grep/read tools to find and cross-reference information. Returns terse excerpts with wikilinks and source references to the DM.

**Context**: Search query. ~50 tokens input.

**Tools**: `grep_campaign(pattern, file_filter?)`, `read_campaign_file(path)`.

**Max tool rounds**: 5 (grep → read → refine → read → summarize).

**Returns**: Terse summary of findings with `[[wikilinks]]` and `(source: path)` references. Results go back to the DM as the tool_result (not fire-and-forget).

---

### 7. Character Promotion Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | DM calls `promote_character` |
| **Source doc** | [entity-filesystem.md](entity-filesystem.md) |

Expands a character file from minimal (a few lines) to full (complete stats, abilities, equipment). Reads the game system's character creation rules, any existing notes, and the DM's context hint.

**Context**: Game system rules, existing character file, DM's context string. ~2-4K tokens.

**Returns**: Confirmation to the DM. Writes/updates the character file directly.

---

### 8. AI Player

| Property | Value |
|---|---|
| **Model** | Haiku (functional) or Sonnet (more personality) |
| **Visibility** | Silent (output enters DM loop as player input) |
| **Trigger** | Engine, when it's an AI player's turn |
| **Source doc** | [multiplayer-and-initiative.md](multiplayer-and-initiative.md) |

Replaces human input for an AI-controlled character. Responds in character, concisely, without narrating outcomes.

**Context**: Character personality prompt + character sheet summary (~200t) + last 3-5 exchanges of DM narration (~500t). Total ~1-2K tokens.

**Returns**: 1-2 sentences of in-character action. ~20-50 tokens. Fed into the DM loop as `[CharName] action text`.

---

### 16. Dev Mode Subagent

| Property | Value |
|---|---|
| **Model** | Sonnet |
| **Visibility** | Player-facing |
| **Trigger** | Toggled from game menu |
| **Source doc** | Implementation-only (`src/agents/subagents/dev-mode.ts`) |

Developer console for power users — inspects and manipulates the running game. Uses the dedicated "dev" frame variant. Workflow is read-before-write: always inspect current state and show findings before mutating.

**Context**: Campaign name + game state summary + dev system prompt. ~2-4K tokens.

**Returns**: Terse summary to the DM when dev mode ends — what was inspected or changed. First sentence is auto-extracted for DM context.

**Dry-run by default**: Always calls diagnostic tools with `dry_run: true` first before applying mutations.

**In scope**: File CRUD (read/write/list/delete/search), live game state (combat, clocks, maps, decks, config), diagnostics, refactoring, git history, all DM tools, engine internals discussion.

**Out of scope**: Narrative/in-character content, rules adjudication, campaign log context.

**Tools available**: File read/write within the campaign directory, state inspection (combat, clocks, maps, decks, config), state mutation. Cannot call DM-only narrative tools. Style: direct, technical, short answers, shows raw data.

---

## Initialization Subagents (during setup)

### 9. Setup Agent

| Property | Value |
|---|---|
| **Model** | Sonnet |
| **Visibility** | Player-facing |
| **Trigger** | App launch → "Start a new campaign" |
| **Source doc** | [game-initialization.md](game-initialization.md) |

Drives the entire game initialization conversation. Personality: dramatic, the opening act. Offers structured choices (3-5 options + freeform) at each step. Delegates mechanical work to Haiku subagents.

**Handles**: Genre selection, system selection, campaign source, mood/difficulty, DM personality, player info, world building. Creates the full campaign directory structure.

---

### 10. Setup Conversation Subagent

| Property | Value |
|---|---|
| **Model** | Sonnet |
| **Visibility** | Player-facing |
| **Trigger** | Setup agent delegates interactive campaign generation |
| **Source doc** | [game-initialization.md](game-initialization.md) |

Multi-turn conversational subagent for interactive campaign setup. The setup agent (Sonnet) orchestrates the flow and delegates the actual conversation to this Haiku subagent for cost efficiency. Supports `present_choices` and `finalize_setup` tool calls.

**Context**: System prompt with personality instructions + conversation history with player. Variable size.

**Returns**: Either a `finalize_setup` call with all campaign parameters, or a `present_choices` call for structured player input.

---

### 11. Narrative Recap Generator

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | Session resume — converts bullet recap to prose |
| **Source** | `src/agents/subagents/narrative-recap.ts` |

Converts bullet-point session recap to narrative prose for the "Previously on..." modal at session start.

**Context**: Bullet-point recap + campaign name. ~500 tokens.

**Returns**: Narrative prose recap. ~100-200 tokens.

---

### 12. Repair State Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | Campaign operations — scans for missing entities |
| **Source** | `src/agents/subagents/repair-state.ts` |

Scans scene transcripts for wikilink targets and generates missing entity files. Ensures the entity filesystem stays consistent with what's been narrated.

**Context**: Transcript text + existing entity list. Variable size.

**Returns**: `RepairResult` — list of entities created/updated.

---

### 13. Theme Styler Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | DM calls `style_scene({ description })` |
| **Source** | `src/agents/subagents/theme-styler.ts` |

Translates natural-language theme requests (e.g., "cyberpunk neon") into structured theme commands. Interprets the DM's aesthetic intent and maps it to the theme system.

**Context**: Description string + current theme + current key color. ~200 tokens.

**Returns**: `ThemeStylerResult` with parsed TUI command.

---

## Planned Subagents (Not Yet Implemented)

> These subagents are designed but have no code. Each links to its tracking issue.

### Character Creation Subagent (Crunchy) — [#69](https://github.com/octopollux/machine-violet/issues/69)

Haiku, player-facing. Walks player through mechanical chargen for rules-heavy systems. See [game-initialization.md](game-initialization.md).

### Rule Card Distiller — [#68](https://github.com/octopollux/machine-violet/issues/68)

Haiku, silent. Reads full game rules, produces dense reference cards. Cuts rules payload by 60-80%. See [randomization.md](randomization.md).

### PDF Extraction Subagent — [#67](https://github.com/octopollux/machine-violet/issues/67)

Haiku (vision), silent. Extracts structured text from PDF pages. See [document-ingestion.md](document-ingestion.md).

### PDF Organization Subagent — [#67](https://github.com/octopollux/machine-violet/issues/67)

Haiku, silent. Sorts extracted PDF content into entity filesystem. See [document-ingestion.md](document-ingestion.md).

### DM Cheat Sheet Generator — [#67](https://github.com/octopollux/machine-violet/issues/67)

Haiku, silent. Summarizes campaign book structure for DM cached prefix. See [document-ingestion.md](document-ingestion.md).

---

## Summary (Implemented Only)

| # | Subagent | Model | Visibility | When |
|---|---|---|---|---|
| 1 | Resolution | Haiku | Silent / Player-facing | Runtime — action resolution |
| 2 | OOC | Sonnet | Player-facing | Runtime — out-of-character mode |
| 3 | Choice Generation | Haiku | Silent | Runtime — player choice options |
| 4 | Scene Summarizer | Haiku | Silent | Runtime — scene transition |
| 5 | Precis Updater + PlayerRead | Haiku | Silent | Runtime — context pruning + engagement tracking |
| 6 | Changelog Updater | Haiku | Silent | Runtime — scene transition |
| 6a | Compendium Updater | Haiku | Silent | Runtime — scene transition |
| 6b | Scribe | Haiku | Silent | Runtime — entity file management |
| 6c | Campaign Search | Haiku | Silent | Runtime — agentic campaign search |
| 7 | Character Promotion | Haiku | Silent | Runtime — on demand |
| 8 | AI Player | Haiku/Sonnet | Silent | Runtime — AI player turns |
| 9 | Setup Agent | Sonnet | Player-facing | Init — game setup (orchestrator) |
| 10 | Setup Conversation | Sonnet | Player-facing | Init — interactive campaign generation |
| 11 | Narrative Recap | Haiku | Silent | Runtime — session resume prose |
| 12 | Repair State | Haiku | Silent | Runtime — missing entity generation |
| 13 | Theme Styler | Haiku | Silent | Runtime — natural-language theme interpretation |
| 16 | Dev Mode | Sonnet | Player-facing | Runtime — developer console |

**Opus is never a subagent** — Opus IS the DM. All subagents are Haiku (cheap mechanical work) or Sonnet (personality/quality needed). The summary table above is the canonical list; model and visibility are columns, not separate counts to maintain.

## Prompt Caching

Most subagents are wired for prompt caching. For subagents whose system prompts are fully static and identical across all users/sessions, cache writes amortize globally — the first call pays full price and subsequent calls see mostly cache reads (25% of input).

Subagents with heavily dynamic system prompts (e.g. AI Player, whose prompt includes character sheet and situation context unique to each call) intentionally skip caching to avoid the cache-write surcharge with no reuse. Narrative Recap's prompt varies only by campaign name, so it caches well within a session.

**Infrastructure** (`src/agents/subagent.ts`):
- `cacheSystemPrompt(text)` wraps a string as `TextBlockParam[]` with `cache_control: { type: "ephemeral", ttl: "1h" }`.
- `oneShot()` auto-wraps its system prompt via `cacheSystemPrompt()`, so one-shot Haiku agents with static system prompts get caching automatically. Agents with fully dynamic prompts should call `spawnSubagent` directly instead.
- `SubagentConfig.cacheTools` stamps `cache_control` on the last tool definition (1h TTL) via `stampToolsCacheControl()` in `agent-session.ts`.

**Sonnet agents** (OOC, Dev Mode) use structured `TextBlockParam[]` system prompts with breakpoints separating stable (cached) and dynamic (uncached) content — the same pattern as the DM's cached prefix.

**Multi-turn Haiku agents** with tools (scribe, search-campaign, search-content) set `cacheTools: true` so tool definitions are also cached across rounds.
