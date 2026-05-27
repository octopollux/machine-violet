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

## Validating changes end-to-end

Before reporting any cross-cutting change as done — anything touching UI flow, session lifecycle, the setup agent, the DM loop, save/load, or any code path that spans server + client + WebSocket — **run a harness scenario**. Type checks and unit tests do not prove the flow works end-to-end.

The canonical handle is the **`/smoketest` skill** (`.claude/skills/smoketest/`). Users invoke it as `/smoketest` (or `/smoketest boot-and-quit`); agents invoke it via the Skill tool when validating cross-cutting work. The skill defaults to `golden-path` and follows the parallelization pattern below.

Underneath, the skill calls these npm scripts directly:

```bash
npm run e2e:boot           # 10s, no API key — precondition for everything else
npm run e2e:golden-path    # 5-10 min, real LLM calls — the baseline smoke test
npm run e2e -- <id>        # any scenario from packages/test-harness/src/scenarios/
```

**The golden path** is the minimum every smoke run does: New Campaign → walk setup-agent → handoff to live campaign → wait for first DM turn (3-5 min, watched via state transitions, not timers) → submit one player turn → receive DM response. Then the harness hard-kills its subprocess — save-on-exit is unit-tested elsewhere and we deliberately skip it to avoid burning a Haiku recap call on every smoke run. Failure prints the screen + state + launcher log so you can diagnose without re-running.

The harness auto-detects an existing `connections.json` by walking up from the worktree (so any worktree can run the live golden path without copying credentials around).

See [docs/e2e-harness.md](docs/e2e-harness.md) for the full scenario catalogue, harness primitives, and how to add a new scenario. New scenarios get registered in `packages/test-harness/bin/run.ts`.

Do not bypass the harness with a hand-rolled `setTimeout` or a "give it 5 minutes" wait — every wait is anchored to an observable state change. If you find yourself reaching for a timer, look in `Harness` for the `waitFor*` helper that fits.

### Parallelize validation: live test in the main thread, lint/tests in a subagent

The golden path is 5-12 minutes of wall-clock waiting. Lint + tests is ~80s. Run them in parallel — but use **different mechanisms**, because subagent Bash has a 10-minute hard cap that breaks live polling.

**Live smoke test** → main thread, `Bash` with `run_in_background: true`:

```
npm run e2e -- golden-path
```

Launch it and continue with other work in the same turn (write the commit message, update docs, plan the next change). The harness auto-invokes you when the process exits, with the full output captured to a tasks/ file. No polling, no babysitting. Foreground `timeout` does not apply to background commands.

**Lint + typecheck + tests** → subagent (`general-purpose`):

> Run `npm run check` and `npx tsc -b` from repo root. PASS → one line. FAIL → paste failure verbatim, no commentary.

~80s, returns cleanly.

**Do NOT delegate the live smoke test to a subagent.** The subagent's Bash tool has a 10-minute hard ceiling. A 12-minute golden path hits that ceiling mid-poll, the agent sees the bash timeout, and returns with "the test is making progress, I'll wait for the notification" — but there is no notification, and the test gets orphaned. Burned an entire test run finding this out the hard way. The main-thread background pattern doesn't share that cap.

**Don't tail the background output in subsequent turns.** Just keep working. When the process exits, the harness re-invokes you with a `<task-notification>` containing the final output path. Read the tail of that file then — not before.

## Release model

Two long-lived branches: **`main`** (trunk, builds nightlies) and **`release`** (the released line, builds stable + RC). Three Velopack channels: `stable`, `rc`, `nightly` — all sticky (installers never auto-switch channels). Only the latest major is supported; no LTS.

**`main` and `release` are not auto-merged into each other.** When fixing a bug:

1. Pick the branch where the bug was reported. A 1.0 user's bug reproduces on `release`, not `main` — `main` may have rewritten the code path, and "can't repro" usually means "looking at the wrong tree."
2. Fix on a branch from there, PR into that long-lived branch.
3. Ask whether the *other* long-lived branch has the same code path. If yes, the fix needs to land there too — cherry-pick or re-apply by hand. Do this both directions (release→main *and* main→release as appropriate).

Cuts go through the **Cut Release** workflow (kind=stable|rc, bump=none|patch|minor|major). Full flow + bootstrap notes in [docs/releases.md](docs/releases.md).

## Worktrees

**Always use a worktree for code changes.** Multiple Claude instances may run concurrently against this repo. Working directly on `main` risks branch collisions and lost commits. Use `EnterWorktree` at the start of every task and `ExitWorktree` when done.

## Commit Hygiene

After completing a coding task, make a detailed commit; you'll need this history later. **Commit freely, but only push and open a PR when the user explicitly asks for it.** Don't preemptively push or create PRs.

## Code Review

Once the user asks you to push and open a PR, **immediately arm a `Monitor` for Copilot's review — do not ask first.** Copilot reviews exactly once but takes 2-10 minutes to arrive. The monitor polls `gh api` and exits once the review lands — no manual polling, and the notification lets you keep working on other things in the meantime. Cap the timeout at 10 minutes so the watch ends even if the review never arrives.

**The review isn't complete until Copilot's top-level summary comment appears.** Copilot always posts a default summary body on `/pulls/:n/reviews` exactly once per PR — that's the signal review is done. Inline comments alone don't count; if only inline comments have arrived, keep waiting until either the summary lands or the timeout fires. Don't act on a partial review.

After the review lands, address any issues you judge worthwhile — use your own judgement on what to fix vs skip (no change in rationale here). Then:

1. **Merge the PR** (the user has already authorized this by asking for the PR).
2. **Notify the user** that the PR has merged.
3. **Do NOT clean up the worktree** — leave it in place. The user will exit it when ready.

Copilot reviews once per PR. Once feedback has been considered and the PR merged, the review loop is over — don't re-arm the monitor.

**Two endpoints, multiple logins.** Copilot posts to *both* `/pulls/:n/comments` (inline review comments, login `Copilot`) and `/pulls/:n/reviews` (top-level review with the summary body, login `copilot-pull-request-reviewer[bot]`). Hardcoding either login misses half the feedback — match on `user.type == "Bot"` plus a case-insensitive substring match on `copilot`, and poll both endpoints.

Example:
```bash
Monitor(
  description: "Copilot review on PR #NNN",
  timeout_ms: 600000,
  persistent: false,
  command: "
    seen=''
    summary_seen=0
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
          case \"$id\" in review-*) summary_seen=1 ;; esac
        fi
      done <<< \"$new\"
      if [ \"$summary_seen\" = \"1\" ]; then
        echo \"[monitor] Copilot summary received; exiting.\"
        exit 0
      fi
      sleep 30
    done
  "
)
```
