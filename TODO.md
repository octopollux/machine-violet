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
- [ ] Implement or remove `center`/`right` formatting tags (render-nodes.tsx)
- [ ] Remove unused `FramedContent` component (FrameBorder.tsx)
- [ ] Fix inconsistent `.js` extensions on imports
- [ ] Add error logging to `StatePersister.writeJSON()` (currently silent)
- [ ] Memoize `computeQuoteState()` in NarrativeArea
- [ ] Externalize model IDs / pricing to config
