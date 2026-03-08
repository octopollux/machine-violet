# Subagents Catalog

Every subagent pattern specified across the design docs. A subagent is a nested Claude API conversation with its own context window — the parent's context is not polluted by the subagent's intermediate work.

**Visibility key**: Silent = DM-only, player never sees it. Player-facing = takes over the TUI temporarily.

---

## Runtime Subagents (during gameplay)

### 1. Resolution Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent (NPC actions) or Player-facing (when player input needed) |
| **Trigger** | DM calls `resolve_action` |
| **Source doc** | [randomization.md](randomization.md) |

The DM's workhorse. Handles all mechanical resolution — attacks, skill checks, saves, ability uses. Reads character sheets and distilled rule cards, determines modifiers, calls `roll_dice` (T1), evaluates results, computes state changes.

**Context**: System prompt with distilled rule cards (cached after first call in a combat), actor's character sheet, target's stats, conditions from the DM. ~2-4K tokens input.

**Returns**: Terse structured result — summary, rolls breakdown, target stat, state changes. ~20-50 tokens.

**Player-facing mode**: When the resolution needs player input ("Use Divine Smite on this hit?", "Which spell slot?"), the subagent temporarily takes over the TUI to ask. The DM doesn't mediate mechanical negotiations.

---

### 2. OOC Subagent

| Property | Value |
|---|---|
| **Model** | Sonnet |
| **Visibility** | Player-facing |
| **Trigger** | DM calls `enter_ooc` |
| **Source doc** | [dm-prompt.md](dm-prompt.md), [overview.md](overview.md) |

Sandboxed conversation for out-of-character discussion. Receives the DM's current context on entry. Handles rules questions, transcript searches, configuration changes, player corrections, validation requests, rollback.

**Context**: DM's cached prefix + recent conversation + OOC system prompt. Full access to campaign filesystem for lookups.

**Returns**: Terse summary to the DM when OOC ends — just what the DM needs to know to resume narrating. Does NOT return the full OOC conversation.

**Tools available**: `rollback`, filesystem reads, validation suite, config updates. Cannot call DM-only tools.

---

### 3. Choice Generation Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent (output displayed as modal) |
| **Trigger** | Engine auto-triggers based on frequency config, or DM calls `present_choices({})` with no params |
| **Source doc** | [tui-design.md](tui-design.md) |

Reads the last few exchanges of DM narration and generates 2-3 reasonable player options. Does not need to be brilliant — freeform input is always available as a fallback.

**Context**: Last 3-5 exchanges of DM narration + player input. ~500-1K tokens.

**Returns**: A prompt string and 2-3 choice strings. ~50 tokens.

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

Developer console for inspecting and manipulating the running game. Has its own tool suite: `read_file`, `write_file`, `inspect_state`, `mutate_state`, `summarize_state`. Uses the dedicated "dev" frame variant.

**Context**: Campaign name + game state summary + dev system prompt. ~2-4K tokens.

**Returns**: Terse summary to the DM when dev mode ends — what was inspected or changed.

**Tools available**: File read/write within the campaign directory, state inspection (combat, clocks, maps, decks, config), state mutation. Cannot call DM-only tools.

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
| **Model** | Haiku |
| **Visibility** | Player-facing |
| **Trigger** | Setup agent delegates interactive campaign generation |
| **Source doc** | [game-initialization.md](game-initialization.md) |

Multi-turn conversational subagent for interactive campaign setup. The setup agent (Sonnet) orchestrates the flow and delegates the actual conversation to this Haiku subagent for cost efficiency. Supports `present_choices` and `finalize_setup` tool calls.

**Context**: System prompt with personality instructions + conversation history with player. Variable size.

**Returns**: Either a `finalize_setup` call with all campaign parameters, or a `present_choices` call for structured player input.

---

### 11. Character Creation Subagent (Crunchy)

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Player-facing |
| **Trigger** | Setup agent delegates during chargen for rules-heavy systems |
| **Source doc** | [game-initialization.md](game-initialization.md) |

Walks the player through mechanical character creation — race, class, stats, background, equipment. Follows the system's chargen rules exactly.

**Context**: Game system chargen rules + player's choices so far. ~3-5K tokens.

**Returns**: Completed character file written to `characters/`.

---

### 12. PDF Extraction Subagent

| Property | Value |
|---|---|
| **Model** | Haiku (vision) |
| **Visibility** | Silent |
| **Trigger** | Document import pipeline, Phase 1 |
| **Source doc** | [document-ingestion.md](document-ingestion.md) |

Extracts structured text from PDF pages. Uses vision for complex layouts (multi-column, stat blocks, sidebars). Each page processed independently.

**Context**: One PDF page (image or text) + extraction instructions. ~1-2K tokens input.

**Returns**: Structured markdown of the page content.

---

### 13. PDF Organization Subagent

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | Document import pipeline, Phase 2 |
| **Source doc** | [document-ingestion.md](document-ingestion.md) |

Reads extracted content from Phase 1 and sorts it into the entity filesystem: rules → `rules/`, locations → `locations/`, NPCs → `characters/`, etc. Converts cross-references to wikilinks.

**Context**: Extracted page content + filesystem structure. Variable size.

**Returns**: Files written to campaign directory.

---

### 14. Rule Card Distiller

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | Game init (after rules import) or document import pipeline |
| **Source doc** | [randomization.md](randomization.md), [document-ingestion.md](document-ingestion.md) |

Reads full game rules and produces dense reference cards — compressed cheat sheets optimized for mechanical resolution. Cuts rules payload by 60-80% for crunchy systems.

**Context**: Full rules text for a topic (e.g., combat chapter). Variable size.

**Returns**: Distilled rule card markdown. ~200-500 tokens per topic.

---

### 15. DM Cheat Sheet Generator

| Property | Value |
|---|---|
| **Model** | Haiku |
| **Visibility** | Silent |
| **Trigger** | Document import pipeline, Phase 3 (campaign books only) |
| **Source doc** | [document-ingestion.md](document-ingestion.md) |

Summarizes campaign book structure into a dense cheat sheet: act/chapter breakdown, key NPCs, plot branches, ticking clocks, important locations. Goes into the DM's cached prefix at session start.

**Context**: Full organized campaign content. Variable size.

**Returns**: DM cheat sheet markdown. ~500-1000 tokens.

---

## Summary

| # | Subagent | Model | Visibility | When |
|---|---|---|---|---|
| 1 | Resolution | Haiku | Silent / Player-facing | Runtime — action resolution |
| 2 | OOC | Sonnet | Player-facing | Runtime — out-of-character mode |
| 3 | Choice Generation | Haiku | Silent | Runtime — player choice options |
| 4 | Scene Summarizer | Haiku | Silent | Runtime — scene transition |
| 5 | Precis Updater + PlayerRead | Haiku | Silent | Runtime — context pruning + engagement tracking |
| 6 | Changelog Updater | Haiku | Silent | Runtime — scene transition |
| 7 | Character Promotion | Haiku | Silent | Runtime — on demand |
| 8 | AI Player | Haiku/Sonnet | Silent | Runtime — AI player turns |
| 9 | Setup Agent | Sonnet | Player-facing | Init — game setup (orchestrator) |
| 10 | Setup Conversation | Haiku | Player-facing | Init — interactive campaign generation |
| 11 | Character Creation | Haiku | Player-facing | Init — crunchy chargen |
| 12 | PDF Extraction | Haiku (vision) | Silent | Init — document import |
| 13 | PDF Organization | Haiku | Silent | Init — document import |
| 14 | Rule Card Distiller | Haiku | Silent | Init — rules compression |
| 15 | DM Cheat Sheet | Haiku | Silent | Init — campaign book summary |
| 16 | Dev Mode | Sonnet | Player-facing | Runtime — developer console |

### Model distribution

- **Haiku**: 12 subagents (cheap mechanical work)
- **Sonnet**: 3 subagents (OOC, setup orchestrator, dev mode — need personality/quality)
- **Haiku/Sonnet configurable**: 1 (AI player)
- **Opus**: 0 subagents (Opus IS the DM, never delegated to)

### Visibility distribution

- **Silent**: 10 (DM-only, player never sees)
- **Player-facing**: 6 (OOC, setup, setup conversation, crunchy chargen, resolution when input needed, dev mode)
