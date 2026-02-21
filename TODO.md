# TODO

When creating a plan to do any of these items, include a step to update this TODO file!

## Refactoring

### Replace prop drilling with context in TUI layer
- [ ] Create `GameContext` provider (or `useGameState()` hook)
- [ ] Refactor Layout from 15 props to context consumer
- [ ] Update child components to pull from context

## Bugs

- [x] ~~Newlines between turns don't appear in the conversation view.~~ (`onNarrativeDelta` now preserves blank-line separators instead of appending to them)
- [x] ~~Text justification formatting instructions missing from the agents that use formatting (DM and setup-conversation).~~ (Added `<center>`, `<right>` with spacing notes to dm-identity and setup-conversation prompts)
- [x] ~~`<center>` formatting should add a newline before and after the text segment so it has space to center in.~~ (`padAlignmentLines()` preprocessor in formatting.ts; prompts note `(auto-adds spacing)`)
- [x] ~~Quote-matching coloring needs to also color the quote marks themselves.~~ (Already implemented — `splitQuotesWithState` includes quotes in color nodes)
- [ ] Initial DM instructions at campaign start are written to the transcript, making them appear in the user-visible conversation view when the game is loaded from disk.

## Features

- [ ] **Cost display**: Move to Esc menu (bottom right).
- [ ] **Cost calculation**: Use the SDK's cost API to calculate accurate costs from token counts. Must handle caching and not hardcode model-specific pricing — models and prices will change.
- [ ] **Periodic formatting reminder**: Re-insert a prompt into the DM's context periodically so it doesn't forget to use formatting.
- [ ] **State folder rename**: Local state folder should be `.tui-rpg`, not `tui-rpg` — the code repo is typically named `tui-rpg` and this gets confusing.
- [ ] **Modeline/theme persistence**: Should persist to disk immediately and load with the session; modeline should be per-character.
- [x] ~~**"Press ENTER to continue" tool**~~: Implemented as `pause_for_effect` TUI tool. Shows overlay modal; ENTER/ESC dismisses.
- [x] ~~**DM worldbuilding tools**~~: `create_entity` and `update_entity` tools. Engine-intercepted for async file I/O. DM prompt guidance for proactive worldbuilding.
- [ ] **Game state agent knowledge**: Embed enough knowledge for certain agents to manually inspect and modify game state. Maybe a skill?
- [ ] **Filesystem sandboxing**: Prevent agents from making unsafe tool calls — especially file access outside the game state area. Could use hooks.
- [ ] **Dev Mode context inspector**: Ergonomic way to inspect agent context for debugging and cache optimization.
- [x] ~~**Progressive character updates**~~: DM prompt guidance to record player-revealed character info via `update_entity`. Sparse initial template signals progressive enrichment.
- [x] ~~**Character Color in conversation view**~~: Player input lines render `>` in bright green and text in the character's theme color, via NarrativeLine detection.



## Completed

<details>
<summary>Done (click to expand)</summary>

### Split `app.tsx` god component
- [x] Extract phase components (FirstLaunch, MainMenu, Setup, Playing)
- [x] Reduce root App to phase router + shared state provider (1332 → 482 lines)
- [x] Eliminate ref-syncing anti-pattern; extract useTextInput, useGameCallbacks hooks
- [x] Move detectSceneState to scene-manager.ts

### Extract shared utilities
- [x] usage-helpers.ts, paths.ts (norm()), useScrollHandle.ts, tokens.ts, sortByInitiative()
- [x] Fix punycode deprecation warning

### Add subagent tests
- [x] All 8 subagents tested (choice-generator, ooc-mode, ai-player, character-promotion, scene-summarizer, precis-updater, changelog-updater, setup-conversation)

### Break up `sceneTransition()`
- [x] Extract 8 steps into named methods on SceneManager

### Standardize subagent result types
- [x] SubagentResult\<T\> wrapper type, all subagents updated

### Clean up dead features & minor issues
- [x] center/right formatting tags, remove unused FramedContent, memoize computeQuoteState
- [x] Error logging for StatePersister, externalize model IDs/pricing, verify import extensions

### Externalize prompts
- [x] Move 12 embedded prompt strings to src/prompts/*.md

</details>
