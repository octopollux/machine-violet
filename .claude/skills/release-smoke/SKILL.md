---
name: release-smoke
description: Pre-cut install-method smoke test — install Machine Violet from the SHIPPED artifact on a clean machine, via every install method for the platform, authenticate a provider from scratch, and play a few live turns. USE THIS before promoting main → release for a cut, or when the user says "smoke test the installers", "test the install methods", "/release-smoke", "validate the release candidate", "are we ready to cut". Takes ~1h and spends real budget. NOT for the source-tree live walk (that's /smoketest) or the offline regression check (that's /replay-goldens).
---

# Release smoke (pre-cut, live, human-driven)

Install from the shipped artifact the way a user does, auth from scratch, play. Once per install method, per platform. Why it exists and what it must cover: [docs/releases.md](../../docs/releases.md#pre-cut-verification-the-install-method-smoke-test).

**The whole point is to launch the app the way a user does.** Every automated gate we have (`verify-package`, the Velopack install-smoke, the agent sidecar) drives the binary in a way that bypasses `checkTerminal()` and makes no live provider call. If you automate this via the sidecar, you have rebuilt the blind spot and proven nothing new. **Double-click.**

## Step 0: warn the user, before you touch anything

This wipes local state repeatedly. **Say what's going, by name, and wait** — don't infer consent from "state is expendable" or "go ahead and clean it"; they're picturing config, not necessarily their campaigns.

> Heads up — this smoke test wipes local state between each install method:
> - **Campaigns** (`%USERPROFILE%\Documents\.machine-violet`, `%TEMP%\mvplay`) — **real, unrecoverable game data**
> - **Config + saved connections** (`%APPDATA%\MachineViolet`) — you'll re-do the OAuth sign-in each round
> - **Any installed build** (`%LOCALAPPDATA%\MachineViolet`)
>
> Back up anything you want to keep first, and tell me when to go.

Then back it up yourself anyway, as a second net — enumerate what's actually on disk and zip it before the first uninstall. In the 1.1 pass this turned up 60 MB of playtest campaigns and rendered scenes nobody had in mind when they said "go ahead". Report where the backup landed.

## Pick the artifact

Test the build that will *become* the release — normally today's **nightly**, which builds from `main` HEAD. Check what you're testing:

```bash
gh release view nightly --json targetCommitish,publishedAt
git log origin/main --oneline -1     # do they match?
```

Testing `release` (v*-rc.N) instead is valid but often misleading: `release` may lack fixes that are already on `main`, so you'll rediscover known bugs. If `main` is ahead, either test nightly or trigger one:
`gh workflow run nightly.yml --ref main`.

## Procedure (per install method)

1. **Wipe, then verify the wipe.** Uninstall, clear state, and confirm each path below is actually gone — cleaning is your job every iteration, not a state you inherit or reason about. Back up first.
2. **Install** from the downloaded artifact.
3. **Verify the signature** (Windows): `Get-AuthenticodeSignature` → expect `Valid`, and confirm it's **timestamped** — Trusted Signing certs are short-lived (days), and the countersignature is what keeps the artifact verifying after expiry.
4. **Launch as a user would** — double-click / Start Menu / `machine-violet` on PATH. Not a harness, not the sidecar.
5. **Check the process tree** (Windows) — the game must be parented to the **bundled** terminal:
   ```
   WindowsTerminal.exe   …\current\terminal\WindowsTerminal.exe   ← bundled
   └── MachineViolet.exe …\current\MachineViolet.exe
   ```
   Parented to a system WT (`C:\Program Files\WindowsApps\…`) means the bundled-terminal probe missed — the #729 class. This check is the reason the whole exercise exists; don't skip it.
6. **Authenticate from scratch.** Ping the user — OAuth needs a human. Then verify what actually landed (below).
7. **Play a few turns.** Setup → handoff → 2+ in-game turns.

## Verify the auth, don't assume it

An ambient `OPENAI_API_KEY` (it's persisted in `HKCU\Environment` on the dev box) auto-creates an `openai-apikey` connection — a *different provider* from ChatGPT/subscription auth, which never touches codex. A smoke test can pass green on it and prove nothing about the OAuth path.

```powershell
# provider must be openai-chatgpt / source oauth
Get-Content "$env:APPDATA\MachineViolet\connections.json" | ConvertFrom-Json |
  Select-Object -ExpandProperty connections | Select-Object provider,source,label
```

Also confirm the **tier assignments** point at the intended connection — auto-assign takes the *first* connection with tier defaults, so an env key sitting first will silently claim the tiers:

```powershell
(Invoke-RestMethod "http://127.0.0.1:<port>/manage/connections").tierAssignments
```

And confirm codex resolved to the **vendored** binary, not a PATH fallthrough:

```bash
grep -o '"binaryPath":"[^"]*"' <campaigns>/.debug/engine.jsonl | sort -u
#  good: …\current\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe
#  bad:  "codex"   ← PATH lookup, ENOENT incoming
```

## Clean state (Windows)

Back up before wiping — restoring `connections.json` saves redoing OAuth on every iteration, and campaigns are the user's data:

| What | Where |
|---|---|
| Config (`connections.json`, `config.json`) | `%APPDATA%\MachineViolet` |
| Campaigns | `%USERPROFILE%\Documents\.machine-violet` (created lazily — absent ≠ wiped) |
| Install | `%LOCALAPPDATA%\MachineViolet` (uninstall via `Update.exe --uninstall --silent`) |
| `/play` sessions | `%TEMP%\mvplay` |

`~/.codex` is the user's own codex CLI home — **not** MV's auth store (MV allocates an isolated per-session `CODEX_HOME`). Leave it alone.

`Update.exe --uninstall` returns before it finishes and schedules a final `rmdir`. Poll for the install dir to disappear; don't pipe it to `Out-Null` and wait (it blocks).

## Driving the turns

Once auth is in place, the turns themselves can be driven — the launch is the part that must be manual:

```bash
npm run smoketest -- --binary "$LOCALAPPDATA/MachineViolet/current/MachineViolet.exe"
```

`--binary` goes through the real launcher (not the sidecar) and, being compiled, resolves `configDir()` to the real `%APPDATA%\MachineViolet` and uses your actual saved connections. Campaigns still go to a temp dir. Close the interactive instance first — two builds sharing the config dir contend over codex.

**Known false failure:** Phase 5b reports a timeout whenever a scribe runs on the preceding turn (#735). The DM completes the turn correctly; the probe mis-observes it. Confirm by reading the log for a `turn:dm_complete` after the reported failure before believing it.

## Gotchas that cost real time

- **PowerShell eats `--`.** `& $wt --title "x" -- $exe` silently drops the `--`; use `--%` or a single quoted arg string. Several "the launcher is broken" conclusions were this.
- **Git Bash mangles `git show origin/main:path`** into `origin\main;path` and returns *nothing*, which greps as zero matches — a false all-clear. Use `git grep -n <pat> origin/main -- <path>`.
- **Redirecting stdout trips the TTY guard.** `MachineViolet.exe --version > out.txt` prints "cannot run in this terminal" — that's the redirect, not the bug. (`--version` genuinely was broken before #733; both things were true at once.)
- **A stale terminal window can mask or mimic a launch bug.** Check process start times before believing a window belongs to your launch.
- **Terminal must be ≥ 80×25** or you get "Terminal Too Small" and nothing starts.

## Report

Findings → issues, before the cut. Anything reaching the packaged product is a blocker by default (RC testers install by hand; stable users can't). Say plainly what you did *not* cover — channel stickiness and the update lifecycle are perennially untested and easy to leave silent.
