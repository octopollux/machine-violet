# Design Docs vs Implementation: Reconciliation Plan

## How to Use This Plan

**This is a living checklist across many context windows.** When you complete a step, delete its entire section (### heading through the `---` divider) from this file so the next session sees only remaining work. If a step turns out to be unnecessary or gets superseded, delete it with a one-line comment at the deletion point explaining why (e.g., `<!-- A5 removed: define_region already registered as of commit abc123 -->`).

## Overview

Comparison of 16 design documents against the current codebase (491 tests, ~148 source files).
Excludes document ingestion (Phase 7) and extended theming per instructions.

---

## Part A: Missing Functionality to Add

<!-- A1 removed: choice auto-generation already wired in useGameCallbacks.ts:131-153 onNarrativeComplete -->
<!-- A2 removed: AI player auto-turns wired into GameEngine.processAITurnIfNeeded() / executeAITurn() -->
<!-- A3 removed: scene_transition / session_end registered as DM-callable tools in tool-registry.ts, intercepted in game-engine.ts -->

<!-- A4 removed: context_refresh tool implemented in scene-manager.ts + tool-registry.ts + game-engine.ts -->
<!-- A5 removed: define_region registered as DM tool + set_terrain region-path bug fixed -->

<!-- A6 removed: Git auto-commit wired — CampaignRepo injected into SceneManager/GameEngine, stepCheckpoint() calls sceneCommit(), trackExchange() after each exchange -->

### A7. Complete Rollback End-to-End

**Design says:** OOC agent provides `rollback` tool. Targets: commit hash, scene label, "last", "exchanges_ago:N". After rollback, `session_resume` reloads DM context.

**Current state:** `rollback` is registered in tool-registry. `campaign-repo.ts` has rollback capability. But nothing connects them — the tool handler doesn't call the repo, and post-rollback session resume isn't triggered.

**Work:**
1. Wire the `rollback` tool handler to `campaign-repo.ts`
2. After successful rollback, trigger state reload (re-read persisted state, rebuild context)
3. Expose in OOC mode

**Files:** `src/agents/tool-registry.ts`, `src/tools/git/campaign-repo.ts`, `src/agents/game-engine.ts`

---

<!-- A8 removed: auto-validation wired into sceneTransition() and sessionResume(); validate tool intercepted in game-engine.ts -->

<!-- A9 removed: resumePendingTransition() implemented in SceneManager + GameEngine + StatePersister.loadPendingOp() + app.tsx resume flow wired -->

### A10. Add Character Creation Subagent (Crunchy Systems)

**Design says:** Dedicated Haiku subagent for rules-heavy character creation (race, class, stats, background, equipment). Separate from setup agent. Player-facing, walks through mechanical choices.

**Current state:** Character creation is inline in `setup-agent.ts` (line 218–257) using AI-generated options, but it's not a full mechanical walkthrough. No dedicated subagent file.

**Work:** Create `src/agents/subagents/character-creation.ts`. When system is crunchy (FATE, D&D, etc.), setup agent delegates to this subagent for detailed mechanical chargen. Reads rules files, walks through each step, writes character file.

**Files:** New `src/agents/subagents/character-creation.ts`, `src/agents/setup-agent.ts`

---

### A11. Implement Rule Card Distiller Subagent

**Design says:** Haiku subagent reads full game rules, produces dense reference cards optimized for mechanical resolution. Cuts rules payload by 60–80% for crunchy systems. Triggered at game init after rules import.

**Current state:** Not implemented.

**Work:** Create `src/agents/subagents/rule-distiller.ts`. After rules are available (fetched or imported), run distiller to produce compressed rule cards stored in `rules/` directory. These cards are what goes into the DM's cached prefix.

**Files:** New `src/agents/subagents/rule-distiller.ts`, `src/agents/setup-agent.ts` or `src/agents/world-builder.ts`

---

### A12. Implement Rules Fetching at Game Init

**Design says:** At init, if supported system selected, engine fetches canonical SRD URL, caches to `rules-cache/<system>.md/.json`. Short systems (24XX, Risus) injected directly into DM prompt.

**Current state:** System selection exists (FATE Accelerated, 24XX offered) but no fetching occurs. Rules are not downloaded or cached.

**Work:** Build a rules-fetching module. Map known systems to SRD URLs. Fetch at init time, cache locally. For short systems, embed in DM prefix. For longer ones, run through rule card distiller.

**Files:** New `src/config/rules-fetch.ts` or similar, `src/agents/setup-agent.ts`, `src/agents/world-builder.ts`

---

### A13. Add Missing Game Systems to Selection

**Design says:** 10+ systems: FATE, Risus, Fudge, Open D6, 24XX, Cairn, D&D 5e SRD, Ironsworn, PbtA frameworks, and more.

**Current state:** Only FATE Accelerated and 24XX offered in setup. No D&D 5e, Risus, Cairn, Ironsworn etc.

**Work:** Expand SYSTEM_STEP in `setup-agent.ts` to include more systems (at minimum: D&D 5e SRD, Risus, Cairn, Ironsworn). Map each to SRD URLs for rule fetching (A12). For "More choices..." option, allow text input matching against known systems.

**Files:** `src/agents/setup-agent.ts`, rules-fetch module from A12

---

<!-- A14 removed: Session resume modal wired — app.tsx now shows SessionRecapModal via setActiveModal instead of appending recap to narrative text -->

<!-- A15 removed: extended theming, deferred until after playtesting -->

<!-- A16 removed: Verified adequate — stubOldToolResults() in conversation.ts takes first line + truncates to 80 chars. Tool handlers already return terse first lines (e.g. "1d20+5: [18]→23"). No code changes needed. -->

---

## Part B: New Functionality to Document in Design Docs

<!-- B1 removed: Dev Mode subagent documented in subagents-catalog.md (#16) + tui-design.md (dev variant) -->
<!-- B2 removed: PlayerRead documented in subagents-catalog.md (Precis Updater §5) + context-management.md -->
<!-- B3 removed: Setup Conversation subagent documented in subagents-catalog.md (#10) + game-initialization.md (two-tier architecture) -->
<!-- B4 removed: switch_player documented in tools-catalog.md (Player Management section) -->
<!-- B5 removed: validate on-demand documented in tools-catalog.md (Error Recovery section) -->
<!-- B6 removed: advance_turn documented in tools-catalog.md (Combat section, per-combatant granularity noted) -->
<!-- B7 removed: Cost display documented in tui-design.md (modeline description) -->
<!-- B8 removed: Scroll indicators + PageUp/PageDown documented in tui-design.md (narrative area + modal behavior) -->
<!-- B9 removed: Quote highlighting documented in tui-design.md (DM Text Formatting section) -->
<!-- B10 removed: Dev frame variant documented in tui-design.md (5 variants, style definition example updated) -->

---

---

## Part C: Implementation Priorities

Reordered for systemless-play-first refinement. Game-system-dependent items deferred to end.

### Tier 1 — Wire Up What's Already Built
These subagents/modules are complete but not connected to the game loop.

1. ~~**A1** — Wire choice auto-generation~~ ✓ (already wired in useGameCallbacks.ts)
2. ~~**A2** — Wire AI player auto-turns~~ ✓
3. ~~**A3** — Register `scene_transition` / `session_end` as DM-callable tools~~ ✓
4. ~~**A6** — Git auto-commit on schedule~~ ✓
5. **A7** — Complete rollback end-to-end (tool registered, repo has capability, nothing connects them)

### Tier 2 — Small Additions to Fill Gaps
Low effort, finish what's partially there.

6. ~~**A4** — Implement `context_refresh` tool~~ ✓
7. ~~**A5** — Register `define_region` as DM tool + fix `set_terrain` region bug~~ ✓
8. ~~**A8** — Run validation at scene transitions and session start~~ ✓
9. ~~**A14** — Verify `session_resume` / "Previously on..." flow is fully wired~~ ✓
10. ~~**A16** — Verify tool result stubbing produces useful one-line summaries~~ ✓

### Tier 3 — Robustness & Recovery
11. ~~**A9** — Pending operation tracking (idempotent cascade recovery)~~ ✓

<!-- A15 (4 missing frame styles) dropped: extended theming, requirements will be revised after playtesting -->

### Tier 4 — Documentation (Part B)
13. ~~**B1–B10** — Update design docs to reflect new implementation features~~ ✓

### Tier 6 — Game System Infrastructure (Deferred)
Not needed for systemless play. Tackle when moving beyond narrative-only mode.

14. **A12** — Rules fetching (fetch SRDs, cache locally)
15. **A13** — Expand game system selection (D&D 5e, Risus, Cairn, Ironsworn, etc.)
16. **A11** — Rule card distiller subagent
17. **A10** — Character creation subagent (crunchy/mechanical chargen)

---

## Part D: Remaining Gaps

The core gameplay loop, tools, TUI, and context management are solid. Remaining gaps are tracked as GitHub issues:

- **[#67](https://github.com/Orthodox-531/machine-violet/issues/67)** — Document ingestion pipeline
- **[#68](https://github.com/Orthodox-531/machine-violet/issues/68)** — Rules system integration (fetching, selection, distillation)
- **[#69](https://github.com/Orthodox-531/machine-violet/issues/69)** — Character creation subagent (crunchy systems)
- **[#70](https://github.com/Orthodox-531/machine-violet/issues/70)** — Wire rollback end-to-end
