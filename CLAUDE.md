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

### CPU-efficient iteration

Multiple agents often run in parallel against this repo; `npm test` is ~80s CPU/run and dominates total check cost. Lint (with `--cache`) and typecheck (`tsc -b` incremental) are already cheap to re-run.

For mid-iteration validation, prefer targeted vitest over the full suite:
- **`npx vitest run --changed`** — only tests for files changed since HEAD. ~3s CPU on a clean tree.
- **`npx vitest run related <files>`** — only tests reachable from the given files.

Reserve `npm run check` for the pre-commit / pre-PR gate. Use your judgement: full suite for risk-sensitive or cross-cutting changes, targeted for routine iteration.

## Cost Awareness

Live API key in `.env` with limited credit. Default dev override uses Sonnet for DM. Don't make unnecessary API calls in manual testing.

## Worktrees

**Always use a worktree for code changes.** Multiple Claude instances may run concurrently against this repo. Working directly on `main` risks branch collisions and lost commits. Use `EnterWorktree` at the start of every task and `ExitWorktree` when done.

## Commit Hygiene

After completing a coding task, make a detailed commit; you'll need this history later.

## Code Review

After creating a PR, **always immediately arm a `Monitor` for Copilot's review — do not ask first.** Copilot reviews once but takes 2-10 minutes to arrive. The monitor polls `gh api` for new review comments and exits once the review lands — no manual polling, and the notification lets you keep working on other things in the meantime. Cap the timeout at 10 minutes so the watch ends even if the review never arrives. Address any issues you judge worthwhile — use your own judgement on what to fix vs skip.

**Two endpoints, multiple logins.** Copilot posts to *both* `/pulls/:n/comments` (inline review comments, login `Copilot`) and `/pulls/:n/reviews` (top-level review with an optional summary body, login `copilot-pull-request-reviewer[bot]`). Hardcoding either login misses half the feedback — match on `user.type == "Bot"` plus a case-insensitive substring match on `copilot`, and poll both endpoints.

Example:
```bash
Monitor(
  description: "Copilot review on PR #NNN",
  timeout_ms: 600000,
  persistent: false,
  command: "
    seen=''
    is_copilot='.user.type == \"Bot\" and (.user.login | ascii_downcase | test(\"copilot\"))'
    while true; do
      inline=$(gh api repos/OWNER/REPO/pulls/NNN/comments --jq \".[] | select($is_copilot) | \\\"\\(.id) \\(.path):\\(.line // .original_line) \\(.body | gsub(\\\"\\\\n\\\"; \\\" \\\"))\\\"\" 2>/dev/null || true)
      reviews=$(gh api repos/OWNER/REPO/pulls/NNN/reviews --jq \".[] | select($is_copilot and ((.body // \\\"\\\") | length > 0)) | \\\"review-\\(.id) [review:\\(.state)] \\(.body | gsub(\\\"\\\\n\\\"; \\\" \\\"))\\\"\" 2>/dev/null || true)
      new=$(printf '%s\n%s\n' \"$inline\" \"$reviews\")
      while IFS= read -r line; do
        [ -z \"$line\" ] && continue
        id=$(echo \"$line\" | awk '{print $1}')
        if ! echo \"$seen\" | grep -q \"\\b$id\\b\"; then
          echo \"$line\"
          seen=\"$seen $id\"
        fi
      done <<< \"$new\"
      sleep 30
    done
  "
)
```
