# TODO

When creating a plan to do any of these items, include a step to update this TODO file!

## Refactoring


## Bugs

- [x] Scroll hotkeys do not work to scroll the main conversation view in OOC/Dev modes

## Features
- [ ] PgUp/PgDown/+/- should work to scroll the main conversation view when any bottom (as opposed to center) modal is active.
- [ ] **Cost display**: Move to Esc menu (bottom right).
- [ ] **Cost calculation**: Use the SDK's cost API to calculate accurate costs from token counts. Must handle caching and not hardcode model-specific pricing — models and prices will change.
- [ ] **Hex colors in character sheets**: In the character sheet modal, match on hex color strings (`#\d{6}`) and render the string itself to the specified color. This is so that users can see their color.
- [ ] Claude API connection errors should gracefully force a center-screen modal; this modal should poll a cheap Claude API endpoint (is there a health check endpoint?) and close automatically.
- Session recap should use a center modal, and the DM's turn should not begin until the user has cleared it.



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
