# Machine Violet

Agentic AI Dungeon Master that runs any tabletop RPG in a terminal.

```bash
npm install
npm run check           # lint + tests (run before every PR)
npm run dev             # launch two-tier (needs ANTHROPIC_API_KEY in .env)
```

## Documentation

All documentation lives in `docs/`. Start at `docs/index.md` for navigation, `docs/overview.md` for the spec index.

**Code and docs stay in sync.** Changes to game behavior, APIs, or on-disk formats require corresponding doc updates in the same commit. See `docs/maintenance.md` for what to update when. API schemas (`packages/shared/src/protocol/rest.ts`, `events.ts`) stay in sync with routes and `docs/websocket-api.md`.

## Conventions

### TypeScript
- `module: nodenext` — **all imports must end with `.js`**.
- Barrel `index.ts` files exist in many directories — check before reaching into subdirectories.
- ESLint flat config; unused params prefixed with `_`.

### State & I/O
- **No globals.** Tool handlers take explicit state objects.
- **FileIO/GitIO interfaces** abstract all I/O. Never call `fs` directly in game logic.
- Tool results use `ok(data)` / `err(message)` helpers.
- Content pipeline (`packages/engine/src/content/`) is **completely separate** from the rest of the game engine. Never import between them.

### Testing
- Tests are **co-located** with source (`foo.ts` + `foo.test.ts`).
- **Cross-platform paths:** use `norm()` helper for all path assertions (backslash → forward slash).
- **Prompt cache:** tests must call `resetPromptCache()` in `beforeEach`.
- **Model config:** tests must call `loadModelConfig({ reset: true })`.
- Vitest `globals: true` — `describe`/`it`/`expect` available without import.
- Anthropic client mocked via `vi.fn()`. FileIO mocked with in-memory `Record<string, string>`.

## Cost Awareness

Live API key in `.env` with limited credit. Default dev override uses Sonnet for DM. Don't make unnecessary API calls in manual testing.

## Worktrees

**Always use a worktree for code changes.** Multiple Claude instances may run concurrently against this repo. Working directly on `main` risks branch collisions and lost commits. Use `EnterWorktree` at the start of every task and `ExitWorktree` when done.

## Commit Hygiene

After completing a coding task, make a detailed commit; you'll need this history later.

## Code Review

After creating a PR, poll for Copilot code review comments every two minutes for up to ten minutes (it reviews once but takes 2-10 minutes to arrive). Address any issues you judge worthwhile — use your own judgement on what to fix vs skip.
