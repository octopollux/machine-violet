---
name: dump-state
description: Dump persisted game state for debugging. Use when investigating game bugs, empty conversation logs, missing state, or crash recovery issues.
disable-model-invocation: true
allowed-tools: Bash(npx:*), Read
---

# Dump Game State

Inspect the persisted game state files on disk for a campaign.

## Usage

`/dump-state` — list available campaigns
`/dump-state <campaign-name>` — dump all state for that campaign

## State dump

!`npx tsx scripts/dump-state.ts $ARGUMENTS 2>&1`

## What to look for

When analyzing the state dump above:

- **Empty conversation.json** (`[]`) — normal after a scene transition (conversation is pruned). Check scene.json precis for whether context was preserved.
- **Missing state files** — if a file like `state/combat.json` is absent, that subsystem hasn't been initialized yet (normal).
- **pending-operation.json exists** — a scene transition or session end was interrupted. The `currentStep` field shows where it stopped. This needs `resumePendingTransition()` to complete.
- **scene.json** — `sceneNumber`, `slug`, `precis`, `openThreads`, `npcIntents`, `playerReads`. If precis is empty on scene > 1, the precis updater may not be running.
- **conversation.json** — the exchange history. Each entry has `role`, `content`, and `usage`. If this is large (>10 exchanges), retention enforcement may not be triggering.
- **ui.json** — persisted theme state (`styleName`, `variant`, `keyColor`). If the UI looks wrong on resume, check here.
- **campaign/log.md** — append-only campaign history. If empty after multiple scenes, the scene summarizer subagent isn't running.
- **config.json** — campaign configuration. Check `players`, `choices`, `context` settings.
