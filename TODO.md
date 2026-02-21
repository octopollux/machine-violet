# Maintenance & Refactoring TODO

## 1. Split `app.tsx` god component
- [x] Extract `<FirstLaunchPhase>` component (`src/phases/FirstLaunchPhase.tsx`)
- [x] Extract `<MainMenuPhase>` component (`src/phases/MainMenuPhase.tsx`)
- [x] Extract `<SetupPhase>` component (`src/phases/SetupPhase.tsx`, covers conversational + step-by-step)
- [x] Extract `<PlayingPhase>` component (`src/phases/PlayingPhase.tsx`)
- [x] Reduce root App to phase router + shared state provider (1332 → 653 lines)
- [x] Eliminate ref-syncing anti-pattern (useEffect persistence + auto-synced refs)
- [x] Extract `useTextInput()` hook (`src/tui/hooks/useTextInput.ts`)
- [x] Extract `useGameCallbacks()` hook (`src/tui/hooks/useGameCallbacks.ts`)
- [x] Move `detectSceneState()` to `scene-manager.ts`, dedup character sheet loading via `dispatchTuiCommand`
- [x] Final reduction: 653 → 482 lines

## 2. Extract shared utilities
- [x] `src/context/usage-helpers.ts` — consolidate 4 copies of `accUsage()`/`accumulateUsage()`
- [x] `src/utils/paths.ts` — single `norm()` path normalizer, replace 12+ inline copies (5 prod files, 5 test files)
- [x] `src/tui/hooks/useScrollHandle.ts` — deduplicate identical scrollBy logic from NarrativeArea + CenteredModal
- [x] `src/config/tokens.ts` — named `TOKEN_LIMITS` const, replace magic numbers across 6 subagent/engine files
- [x] Extract shared `sortByInitiative()` combat comparator (3 callers → 1 helper)
- [x] Fix punycode deprecation warning — move `process.emit` patch to `src/suppress-warnings.ts` (ESM hoisting fix)

## 3. Add subagent tests
- [x] choice-generator
- [x] ooc-mode
- [x] ai-player
- [x] character-promotion
- [x] scene-summarizer
- [x] precis-updater
- [x] changelog-updater
- [x] setup-conversation

## 4. Break up `sceneTransition()`
- [x] Extract each of the 8 steps into named methods on SceneManager
- [x] Keep the idempotent step-tracking pattern intact

## 5. Standardize subagent result types
- [x] Define `SubagentResult<T>` wrapper type
- [x] Update all subagent return types to use it

## 6. Replace prop drilling with context in TUI layer
- [ ] Create `GameContext` provider (or `useGameState()` hook)
- [ ] Refactor Layout from 15 props to context consumer
- [ ] Update child components to pull from context

## 7. Clean up dead features & minor issues
- [x] Implement `center`/`right` formatting tags (NarrativeArea alignment via Box justifyContent)
- [x] Remove unused `FramedContent` component (FrameBorder.tsx)
- [x] Fix inconsistent `.js` extensions on imports (already consistent — verified all 148 files)
- [x] Add error logging to `StatePersister.writeJSON()` (optional onError callback)
- [x] Memoize `computeQuoteState()` in NarrativeArea (useMemo)
- [x] Externalize model IDs / pricing to config (loadPricingConfig in models.ts, dev-config.json override)

**Above are tech debt cleanup; bugs and features follow**
~~~
Prompts should be external files, not embedded in the TypeScript; this is because the human developer will be using VSCode, and text files wrap and are easily editable, while TS files do not.
~~~
We need to embed enough knowledge for certain agents to be able to manually inspect and modify game state. Maybe a skill?
~~~
Is anything preventing agents from making unsafe tool calls - especially file access outside of the game state filesystem area? If not, could be implemented using hooks, for example
~~~
Dev Mode needs an ergonomic way to really inspect agent context (both for debugging and for cache optimization). Open to suggestions!
~~~
The DM needs to update character and player as new information arrives; unlike everything else in game state, the user themselves can progressively reveal information about their own character that the DM does not know; this needs to be recorded.
~~~
Cost display should be moved to Esc menu, at the bottom right.
~~~
Costs should use the SDK's cost API features to calculate accurate costs against token counts; we will want to be sure to actually get costs for the model we are using without any hardcoded assumptions; this needs to take caching into account. Bear in mind that a year from now, both model selection and costs will be wildly different, so hardcoding anything related to this will not hold up well.
~~~
We have code which should print a newline to the conversation view after every turn; this does not seem to work. Frankly I am not sure that newlines work at all in the conversation view.
~~~
Using HTML-ish formatting to center text should also add a newline before and after the text segment; otherwise it has no space in which to center.
~~~
Initial DM instructions at the start of the campaign are written to the transcript in game state; this makes them appear in the user-visible conversation view when the game loaded from disk.
~~~
We need to implement a prompt which is periodically re-inserted into the DM's context; at this time it eventually forgets to use formatting.
~~~
Quote-matching coloring needs to also color the quotes.
~~~
Local state folder should be named `.tui-rpg`, not `tui-rpg`, because the *code repo* is typically named tui-rpg and this gets confusing for the developer!
~~~
Modeline and theme state should persist to disk immediately and load with the session; modeline should be per-character.
~~~
We need to implement a "prompt user to press ENTER to continue" tool, and the game init agent needs to use it immediately before ending its final turn and handing over control to the DM; otherwise the player never gets to see the final paragraph of the world init conversation. The tool is available to the DM without further guidance.
~~~
I'd like to know what options the DM has for worldbuilding for later; ideally they should be able to create new locations/characters/factions/etc whenever they want to, link them together with wikilinks, and just silently stash them; otherwise the world can only be a tunnel-vision side effect of the immediate narrative.
~~~
