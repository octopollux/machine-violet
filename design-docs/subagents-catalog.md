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

Appends a terse summary of the dropped exchange to the running scene precis. Keeps the DM oriented despite the short conversation window.

**Context**: The dropped exchange + current precis. ~500-1K tokens.

**Returns**: Updated precis append. ~20-50 tokens.

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

### 10. Character Creation Subagent (Crunchy)

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

### 11. PDF Extraction Subagent

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

### 12. PDF Organization Subagent

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

### 13. Rule Card Distiller

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

### 14. DM Cheat Sheet Generator

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
| 5 | Precis Updater | Haiku | Silent | Runtime — context pruning |
| 6 | Changelog Updater | Haiku | Silent | Runtime — scene transition |
| 7 | Character Promotion | Haiku | Silent | Runtime — on demand |
| 8 | AI Player | Haiku/Sonnet | Silent | Runtime — AI player turns |
| 9 | Setup Agent | Sonnet | Player-facing | Init — game setup |
| 10 | Character Creation | Haiku | Player-facing | Init — crunchy chargen |
| 11 | PDF Extraction | Haiku (vision) | Silent | Init — document import |
| 12 | PDF Organization | Haiku | Silent | Init — document import |
| 13 | Rule Card Distiller | Haiku | Silent | Init — rules compression |
| 14 | DM Cheat Sheet | Haiku | Silent | Init — campaign book summary |

### Model distribution

- **Haiku**: 11 subagents (cheap mechanical work)
- **Sonnet**: 2 subagents (OOC, setup — need personality/quality)
- **Haiku/Sonnet configurable**: 1 (AI player)
- **Opus**: 0 subagents (Opus IS the DM, never delegated to)

### Visibility distribution

- **Silent**: 10 (DM-only, player never sees)
- **Player-facing**: 4 (OOC, setup, crunchy chargen, resolution when input needed)
