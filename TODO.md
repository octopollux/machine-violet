# TODO

When creating a plan to do any of these items, include a step to update this TODO file!

## Refactoring

### Replace prop drilling with context in TUI layer
- [x] Create `GameContext` provider with `useGameContext()` hook
- [x] Refactor PlayingPhase from 28 props to context consumer
- [ ] Refactor Layout from 15 props to context consumer
- [ ] Update child components to pull from context

## Bugs
- [ ] When restoring state from disk, the transcript doesn't get processed for formatting based on who is speaking; player turns look like DM turns.

## Features

- [ ] **Cost display**: Move to Esc menu (bottom right).
- [ ] **Cost calculation**: Use the SDK's cost API to calculate accurate costs from token counts. Must handle caching and not hardcode model-specific pricing — models and prices will change.
- [ ] **Periodic formatting reminder**: Re-insert a prompt into the DM's context periodically so it doesn't forget to use formatting.
- [x] **State folder rename**: Local state folder should be `.tui-rpg`, not `tui-rpg` — the code repo is typically named `tui-rpg` and this gets confusing.
- [ ] **Modeline/theme state and persistence**: These pieces of state should also persist to disk, and should be brought into DM context on load so it can update them consistently; in fact, we need persistence of state for these in general so that modeline isn't effectively random from scene to scene/session to session.
- [ ] **Game state agent knowledge**: Embed enough knowledge for certain agents to manually inspect and modify game state. Maybe a skill? Ideally designed in such a way that we get the contents of this information "for free" without haing to update it any time we add features/changes to state funtionality - but not absolutely essential.
- [ ] **Filesystem sandboxing**: Prevent agents from making unsafe tool calls — especially file access outside the game state area. Could use hooks.
- [ ] **Hex colors in character sheets**: In the charater sheet modal, match on hex color strings (`#\d{6}`) and render the string itself to the specified color. This is so that users can see their color.
- [ ] Claude API connection errors should gracefully force a center-screen modal; this modal should poll a cheap Claude API endpoint (is there a health check endpoint?) and close automatically.
- Choice modal should always have a final "Enter your own: > _" option that accepts text input in-place; with this addition, the choice modal can sit on top of the normal user input line, saving some space.



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
