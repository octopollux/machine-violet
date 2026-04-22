# Error Recovery Design

The game state is distributed across files, the DM's context, and in-flight operations. Things can get out of sync. This document covers how the engine handles failures, inconsistencies, and player-initiated corrections.

## State Snapshots: Git

The campaign directory is all markdown and JSON — a perfect fit for version control. The engine uses **isomorphic-git** (a pure JavaScript git implementation, no system git dependency) to maintain a local repository in the campaign directory. The player never interacts with git; it's invisible infrastructure.

### Auto-commit schedule

| Event | Commit | Rationale |
|---|---|---|
| Every N exchanges (configurable, default 3) | `auto: exchanges 45-47` | Frequent recovery points during play |
| Scene transition | `scene: Escape from the Goblin Caves` | Natural checkpoint |
| Session end | `session: end session 3` | Clean save point |
| Before destructive operations | `checkpoint: before scene_transition` | Safety net for cascades |
| Character promotion / level-up | `character: Aldric level 5` | Irreversible character changes |

These are local-only commits — nothing is pushed anywhere. The campaign directory stays small, and git deduplicates unchanged files, so thousands of commits add negligible disk overhead.

### Rollback

In OOC mode, the player can ask to roll back:

- "Roll back to before the last combat" → the OOC agent searches git log for the right commit, restores files, then `session_resume` reloads the DM's context from the restored state.
- "Undo the last few turns" → restore to the most recent auto-commit before the problem.

The engine provides a `rollback` tool available to the OOC agent, dev mode, and the `/rollback` slash command:

```
rollback({
  target: "scene:Escape from the Goblin Caves"   // or a commit hash, or "last", or "exchanges_ago:5"
})
```

After rollback completes, a `RollbackSummaryModal` displays what was restored and waits for the player to press Enter. Internally, rollback throws a `RollbackCompleteError` (from `src/teardown.ts`) which propagates through the agent loop and sets the rollback modal. On dismissal, a dedicated `doRollbackReturn()` path resets caches and UI state without calling `gracefulShutdown()` — this prevents in-memory state from being written back to disk and undoing the rollback. Re-entering the campaign loads the restored state via `session_resume`.

### Configuration

```jsonc
// config.json (partial)
{
  "recovery": {
    "auto_commit_interval": 1,     // commit every N exchanges (default 1 — every turn)
    "max_commits": 500,            // prune oldest auto-commits beyond this (keep scene/session commits)
    "enable_git": true             // can be disabled if the user doesn't want it
  }
}
```

## API Failures

### Transient failures (timeout, rate limit, 500, network errors)

Retry with exponential backoff (1s, 2s, 4s, 8s, capped at 12s) **indefinitely** — we never give up. The TUI shows a human-friendly activity label with a live countdown:
- `Connection lost — retrying (12s)` for network errors (ECONNRESET, ETIMEDOUT, etc.)
- `Rate limited — retrying (4s)` for HTTP 429
- `API overloaded — retrying (8s)` for HTTP 529
- `API error (500) — retrying (2s)` for other server errors

Retryable statuses: 429, 500, 502, 503, 529, plus synthetic status 0 for connection-level errors. No state has changed — the API call didn't complete — so there's nothing to roll back.

### Non-retryable API errors (manual retry)

When an API call fails with an error that exhausts automatic retries or isn't in the retryable set, the engine stores the failed input and prompts the player:

```
[Error: 401 Unauthorized]
[Debug info saved to .debug/ folder — see engine.jsonl for structured event log]
[Press Enter to retry]
```

Pressing Enter with an empty input replays the last DM turn (`processInput` with `skipTranscript: true`, since the transcript was already written). The pending retry is cleared on the next successful turn.

### `/retry` slash command

The `/retry` command retries the last DM turn at any time — useful for recovering from garbled output, tool loops, or any unsatisfying response:

- If there's a pending error retry, `/retry` replays that failed input.
- Otherwise, it pops the last exchange from conversation history and replays the original player input (with `skipTranscript: true`).
- Both paths log a `dev` narrative line (visible when verbose display is enabled in Settings).

### Subagent failures

If a Haiku/Sonnet subagent call fails (during resolution, OOC, chargen, etc.), the engine retries the subagent call. The parent (Opus DM) doesn't see the failure unless retries are exhausted, in which case it receives an error result: "Resolution failed — resolve manually or retry." The DM can narrate around it or ask the player to wait.

## Mid-Cascade Failures

Operations like `scene_transition` are multi-step cascades. If a cascade fails partway through (API down during the Haiku summary step), the engine needs to resume from where it stopped.

### Idempotent steps

Each step in a cascade is idempotent — safe to re-run:
- "Write transcript" → skips if the file already exists
- "Advance clock" → skips if the clock value is already past the target
- "Summarize scene" → overwrites any partial summary
- "Update campaign log" → checks if the entry already exists

### Pending operation tracking

During a cascade, the engine writes a marker file:

```jsonc
// state/pending-operation.json
{
  "operation": "scene_transition",
  "started_at": "2026-02-16T15:30:00Z",
  "params": { "title": "Escape from the Goblin Caves", "time_advance": "6 hours" },
  "steps_completed": ["write_transcript", "advance_clock"],
  "steps_remaining": ["summarize_scene", "update_campaign_log", "check_alarms", "refresh_context"]
}
```

On next app launch, if `pending-operation.json` exists, the engine resumes the cascade from where it stopped. Once all steps complete, the marker file is deleted.

## State Inconsistency

### Sources of drift

The most common cause: the DM narrates a state change without calling a tool. "The goblin moves to the doorway" but `map_entity` move was never called. The DM prompt reinforces "call the tool when state changes," but this will fail sometimes — it's an LLM.

### Periodic validation

A Tier 1 (code) validation check runs at scene transitions, session starts, and on demand (via OOC):

- **Wikilink integrity**: every entity linked in the campaign log — does the file exist?
- **Character sheet consistency**: do HP/resource values match what the resolve session last reported?
- **Map consistency**: does every entity placed on a map have a corresponding character file?
- **Clock integrity**: are alarm fire times in the future? Is the calendar monotonically increasing?
- **File format**: are JSON files valid JSON? Do entity files have required front matter?

Validation **detects** problems and **reports** them — it does not auto-fix. Results go to the DM as a system notification:

```
"Inconsistency: Aldric's HP is 42 on character sheet but the resolve
 session last recorded 28. Scene 14 combat may not have been applied."
```

The DM (or the OOC agent, if the player asks) resolves it.

### What validation does NOT do

- It does not check narrative consistency ("DM said the mayor is here but his file says he fled"). This would require running a model on every DM output, which is expensive. Players catch narrative contradictions naturally, just like with a human DM.
- It does not auto-correct. State discrepancies might be intentional (the DM updated something manually), so the engine reports and lets the DM decide.

## Context Degradation

The DM forgets something important and contradicts established facts. This is managed through:

1. **Prevention**: The cached prefix (campaign summary, scene precis, active character states) keeps critical facts in view. The context management design is the primary defense.
2. **Player correction**: The player says "wait, you said the bridge was destroyed." The DM (or OOC agent) searches the transcript, finds the truth, and corrects course. This is normal tabletop gameplay.
3. **OOC correction**: In OOC mode, the player can flag any issue. The OOC agent looks up the facts, makes corrections to files if needed, and returns a summary to the DM.

No active narration-checking is implemented. This may be revisited if testing reveals that context degradation is a frequent problem despite the cached prefix and scene precis.

## Player Recovery Options (via OOC)

| Player says | OOC agent does |
|---|---|
| "Roll back to before the last combat" | `rollback` to the right git commit, `session_resume` |
| "Aldric should have 28 HP" | Updates the character sheet |
| "You forgot we destroyed the bridge" | Notes the correction, returns it in the DM summary |
| "Something feels off, can you check?" | Runs the validation suite, reports inconsistencies |
| "Can I see my save history?" | Lists git commits with human-readable labels |
