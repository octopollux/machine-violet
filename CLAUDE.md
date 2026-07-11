# Machine Violet

Agentic AI Dungeon Master that runs any tabletop RPG in a terminal.

## Agent Metadata

Keep shared agent guidance in this file and reusable workflows in `.claude/skills/`.
Agents from other runtimes should follow these conventions directly rather than
adding runtime-specific instruction or memory files to the repository.

```bash
npm install
npm run check           # lint + tests (run before every PR)
npm run dev             # launch two-tier (needs ANTHROPIC_API_KEY in .env)
```

## Documentation

All documentation lives in `docs/`. Start at `docs/index.md` for navigation, `docs/overview.md` for the spec index.

**Authoring or reviewing campaign seeds** (`worlds/*.mvworld`) — the design bars (place + call-to-action, location skeletons, mystery-box, originality/no-imitation, …), the review checklist, and the repeatable catalog-review loop — live in `docs/seed-authoring.md`. (The `.mvworld` *schema* is `docs/format-spec.md §10`; turning a *played campaign* into a seed is the `build-mvworld` skill.)

**Code and docs stay in sync.** Changes to game behavior, APIs, or on-disk formats require corresponding doc updates in the same commit. See `docs/maintenance.md` for what to update when. API schemas (`packages/shared/src/protocol/rest.ts`, `events.ts`) stay in sync with routes and `docs/websocket-api.md`.

**Authoring image-gen visual styles.** The `.mvstyle` style catalog (`packages/engine/src/prompts/include/Image/`, the per-seed art-direction variants behind `generate_image`) has its own end-to-end workflow — the anti-tic levers, the render-and-eyeball loop, and the banking checklist — in `docs/visual-style-authoring.md`. Read it before adding or editing a style variant.

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

### TUI modals
- **Background bleed-through:** new modals tend to "leak" the narrative behind them. Each row must be a **single physical line padded full-width**, rendered via `CenteredModal`'s `styledLines`/`lines` (which pad opaque) — never raw React children. The usual trap: **free-form/user text containing newlines** (e.g. verbatim player-turn commit messages) breaks a row onto a second, unpadded line that Ink's `trimEnd` then exposes. Collapse whitespace (`s.replace(/\s+/g, " ").trim()`) before truncating. See `RollbackPickerModal.tsx`'s `oneLine` and `docs/tui-design.md#modals`.

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
- **`npx vitest related --run <files>`** — only tests reachable from the given files. (Note the order: `vitest run related <files>` parses `related` as a name-filter and finds nothing — the `related` command needs `--run`, not `run related`. This is also what the pre-commit hook runs on staged files.)

Reserve `npm run check` for the pre-commit / pre-PR gate. Use your judgement: full suite for risk-sensitive or cross-cutting changes, targeted for routine iteration.

## Cost Awareness

Live API key in `.env` with limited credit. Default dev override uses Sonnet for DM. Don't make unnecessary API calls in manual testing.

## Validating changes end-to-end

Type checks and unit tests do not prove a cross-cutting flow works — anything touching UI flow, session lifecycle, the setup agent, the DM loop, save/load, or a path that spans server + client + WebSocket. The e2e strategy is **three tiers, deterministic-first** (full picture: [docs/e2e-harness.md](docs/e2e-harness.md), [docs/golden-tapes.md](docs/golden-tapes.md)):

1. **Tier 1 — component/render:** `ink-testing-library`, co-located in `packages/client-ink`.
2. **Tier 2 — deterministic golden replay (the regression backbone):** the real `GameEngine` (DM loop) and `createSetupConversation` (setup agent → finalize → handoff) replaying recorded **golden tapes**, offline, ~4s. **This is the everyday "did I break it?" gate.** Touch the DM loop or the setup agent → expect to re-record the matching corpus.

   ```bash
   npm run golden:verify     # replay goldens offline (no API key)
   ```

   When a replay fails: decide whether it's a real regression (fix the code) or an intended behavior change (re-record with `npm run golden:record` / the `/record-tape` skill, then review the diff). Never hand-edit a tape. Skills: `/replay-goldens`, `/record-tape`.
3. **Tier 3 — live smoke (rare):** the real launcher stack against the real API. Only when you specifically need the live flow (setup agent, handoff, boot path).

   ```bash
   npm run e2e:boot     # 10s, no API key — boots the stack and quits (cheap precondition)
   npm run smoketest    # 7-12 min, live API — full setup→game walk
   ```

For **live exploration** (feel out a personality/world, reproduce a bug by hand, or record a full-stack golden) drive the **`/play` skill** (`mvplay`) yourself turn-for-turn — being in the loop is the point; don't delegate to a subagent or a scripted probe. For a **repeatable live pass/fail** on one path (save/load round-trip, image-gen persisted), write a one-shot `runProbe` under `packages/test-harness/bin/`.

Do not bypass the harness with a hand-rolled `setTimeout` or a "give it 5 minutes" wait — every wait is anchored to an observable state change. If you find yourself reaching for a timer, look in `Harness` for the `waitFor*` helper that fits.

## Release model

Two long-lived branches: **`main`** (trunk, builds nightlies) and **`release`** (the released line, builds stable + RC). Three Velopack channels: `stable`, `rc`, `nightly` — all sticky (installers never auto-switch channels). Only the latest major is supported; no LTS.

**`main` and `release` are not auto-merged into each other.** When fixing a bug:

1. Pick the branch where the bug was reported. A 1.0 user's bug reproduces on `release`, not `main` — `main` may have rewritten the code path, and "can't repro" usually means "looking at the wrong tree."
2. Fix on a branch from there, PR into that long-lived branch.
3. Port the fix to the *other* long-lived branch **only** when the bug was also reported there, or it's a regression in a shipped (released) version — then cherry-pick or re-apply by hand (both directions as appropriate). Otherwise default to the reported branch alone; don't raise porting routinely. When it *is* warranted, just do it and say so rather than asking.

### Cutting releases

All cuts dispatch GitHub workflows via `gh`. Common commands:

| User asks | Command | Notes |
|---|---|---|
| Cut next RC (new patch) | `gh workflow run cut-release.yml --ref release -f kind=rc -f bump=patch` | Bumps `package.json` then tags `vX.Y.Z-rc.1`. Use `bump=minor`/`major` for new minor/major lines. |
| Cut another RC, same line | `gh workflow run cut-release.yml --ref release -f kind=rc -f bump=none` | Tags `vX.Y.Z-rc.(N+1)` — counter auto-increments off existing tags. |
| Promote RC → stable | `gh workflow run cut-release.yml --ref release -f kind=stable -f bump=none` | Tags the version that's been RC'd. Purges that line's RC releases as part of publish. |
| Cut stable, no RC soak | `gh workflow run cut-release.yml --ref release -f kind=stable -f bump=patch` | For hotfixes / confident small changes. `minor`/`major` also valid. |
| Force a nightly now | `gh workflow run nightly.yml --ref main` | Useful when you've changed the nightly pipeline and want immediate verification, or to refresh the release-list cleanup. |
| Test a Windows build without releasing | `gh workflow run test-build.yml -f windows=true` | Run on any PR touching build/installer/signing before merging — the Windows signing path has no other pre-merge coverage. **Without `--ref`, `gh workflow run` targets the default branch (`main`), not your branch.** To validate a feature/Dependabot branch use `gh workflow run test-build.yml --ref <branch> -f windows=true -f sign=false` — Azure Trusted Signing only authenticates from protected refs, so feature branches must pack unsigned, but still run the full pack → replay → install-smoke gate. |

`cut-release.yml` self-aborts if dispatched from any branch but `release` — the `--ref release` arg is mandatory.

Once dispatched, watch with the background pattern: `gh run watch <run-id> --exit-status > /tmp/log 2>&1` via `Bash` with `run_in_background: true`. The harness re-invokes you on exit. Don't poll.

After cutting an RC or stable, the workflow files you touch (`release.yml`, `cut-release.yml`) may have changes that need cherry-picking onto `release` if they were merged into `main` first. The bidirectional cherry-pick rule above applies.

Full flow, Velopack manifest details, Azure OIDC notes, and bootstrap history in [docs/releases.md](docs/releases.md).

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
