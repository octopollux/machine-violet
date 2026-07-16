# Releases

How Machine Violet is shipped, and how to cut a release.

## Channels

Three Velopack update channels. Each is **sticky** — installers only auto-update within their own channel.

| Channel | Source | Cadence | Audience |
|---|---|---|---|
| `stable` | `release` branch, `v$X.$Y.$Z` tags | When we ship | End users |
| `rc` | `release` branch, `v$X.$Y.$Z-rc.$N` tags | When we want a soak | Technical testers (manual install) |
| `nightly` | `main` branch, daily build | 06:00 UTC daily | Bleeding-edge testers |

We support **only the latest major**. There is no LTS line.

## Branches

- **`main`** — trunk. All feature work lands here. Builds nightlies.
- **`release`** — the released line. Bugfixes land here. Builds stable + RC.
- Feature/fix branches merge into one of the above via PR.

`main` and `release` are **not** auto-merged into each other. When a bug is found:

- **Bug found via `release`** → fix on a branch from `release`, PR into `release`. Then evaluate whether `main` needs the same fix; if so, cherry-pick or re-apply by hand.
- **Bug found on `main`** that also exists on `release` → fix on `main`, then cherry-pick (or re-apply) onto `release`.

Reproduce against the correct branch — a 1.0 user's bug must be reproduced on `release`, not `main`. `main` may have rewritten the code path and "I can't repro" usually means "I'm looking at the wrong tree."

## Pre-cut verification (the install-method smoke test)

**Do this before promoting `main` → `release` for a cut.** It is a human-driven, live pass over every install method on each platform: install from the shipped artifact on a *clean* machine, authenticate a provider from scratch, and play a few real turns. Budget an hour. The `/release-smoke` skill has the full procedure; this section is the why.

**CI cannot do this, and it is worth being precise about why.** The packaged gates do real work — the Velopack smoke performs a genuine `Setup.exe --silent` install and `--uninstall`, and `verify-package` replays goldens against the built artifact on every OS. Credit where due: they catch SEA injection, asset vendoring, install layout, and manifest bugs.

But **every one of them reaches the app through `replay-golden --binary`**, which spawns the exe directly. So no matter how real the install around it is, that path:

- **bypasses `checkTerminal()`**, so nothing exercises the real launch (conhost detection, the Windows Terminal relaunch);
- **never makes a live provider call**, so nothing exercises OAuth, codex spawn, or a real DM turn;
- **runs against state CI just created**, so nothing exercises a stale config or an upgrade over an existing install.

The agent sidecar (`--agent-port`) bypasses `checkTerminal()` too and bootstraps its own mock TTY, so driving a packaged binary over the sidecar — the natural way to automate this — rebuilds the same blind spot. **Nothing in CI launches the app the way a user does.**

This is not hypothetical. In the 1.1 cycle the bundled Windows Terminal was shipped one directory below where `terminal-check.ts` probes for it. `existsSync` returned false, the code silently fell back to whatever system `wt.exe` the user had, and both packaged gates stayed green across two RCs. It took a literal double-click to find (#729). The class is general: **a silent fallback plus a gate that skips the fallback's trigger equals a bug that ships.**

What to cover per platform:

| Platform | Install methods |
|---|---|
| Windows | Velopack installer (`Setup.exe`), portable zip |
| macOS / Linux | Homebrew, `install.sh`, tarball |

Every platform must be exercised **on that platform** — much of what this catches is platform-specific by construction (the Windows Terminal bundling is gated on `matrix.os == 'windows-latest'`, and `findWindowsTerminal()` sits inside a `process.platform === "win32"` branch, so a macOS pass can neither confirm nor contradict it).

Running the platforms in parallel (several machines, or several agents) works well — agree up front on the **same artifact** (same nightly / same tag; "it works on mine" is worthless if you built different trees), and hand findings off through an issue so nobody re-finds someone else's bug. See #734 for the shape.

**Cleaning is a step in the procedure, not a precondition you inherit.** Wipe before the first method and between every method after it — establishing state and auth from nothing is part of what's under test, so a box that is merely *probably* clean tests the wrong thing. Do the wipe yourself and confirm it landed rather than reasoning about whether it was already done. Paths and the uninstall gotchas are in the `/release-smoke` skill.

**Say so before you start.** This destroys local state: installed builds, saved connections, and **campaigns — which are real, unrecoverable user data**. Tell whoever owns the machine what's about to go, by name, and let them back up before the first uninstall. Don't infer consent from "state is expendable" — they may not have this dir in mind. Back up anything worth keeping yourself as a second net (the 1.1 pass turned up 60 MB of playtest campaigns nobody had thought about).

And per method: clean state → install → launch **the way a user launches** (double-click / Start Menu / `machine-violet`, not a harness) → add a provider connection from scratch → play a few turns. Wipe state between methods; establishing state and auth cleanly is part of what's under test.

Cover each **provider auth type** you ship, at least once across the matrix — API key and subscription/OAuth (`openai-chatgpt`) take entirely different code paths. The OAuth path is the one with the interesting failure modes (codex spawn, token refresh, `CODEX_HOME` isolation), and an ambient `OPENAI_API_KEY` in the environment auto-creates an `openai-apikey` connection that will quietly satisfy a smoke test *without touching codex at all* — check `connections.json` shows `"provider": "openai-chatgpt"` rather than trusting that a turn completed.

Findings go to issues before the cut; anything that reaches the packaged product is a blocker by default, since RC testers install by hand and stable users can't.

## Cutting a release

All cuts go through the [Cut Release](../.github/workflows/cut-release.yml) workflow (`Actions → Cut Release → Run workflow`).

**You must select the `release` branch** in the "Use workflow from" dropdown — the workflow refuses to run from any other branch.

Inputs:

| Input | Choices | Meaning |
|---|---|---|
| `kind` | `stable`, `rc` | Which channel to ship to |
| `bump` | `none`, `patch`, `minor`, `major` | Whether to bump `package.json` first |
| `dry_run` | bool | Skip the tag push for verification |

### Typical flows

**Cut RC 1 of a new patch line** — `kind=rc, bump=patch`. Bumps `1.0.0` → `1.0.1` on `release`, tags `v1.0.1-rc.1`.

**Cut RC 2 of the same line** — `kind=rc, bump=none`. Tags `v1.0.1-rc.2` (counter auto-increments).

**Promote RC to stable** — `kind=stable, bump=none`. Tags `v1.0.1`.

**Cut a stable directly without RCs** — `kind=stable, bump=patch`. Tags `v1.0.1`.

**Cut a major release** — `kind=stable, bump=major`. Tags `v2.0.0`. Stable users auto-upgrade across major boundaries; communicate clearly in release notes (e.g. save-format migrations).

The workflow:
1. Bumps `package.json` if requested, commits to `release`.
2. Computes the tag (failing if a stable tag already exists for the current version).
3. Pushes branch + tag.
4. The push of `v*` triggers [release.yml](../.github/workflows/release.yml), which builds Win/macOS/Linux, signs Windows via Velopack + Azure Trusted Signing, **replays the golden corpus against each packaged binary** (the `verify-package` gate), generates AI release notes (Sonnet, adaptive thinking), and creates the GitHub release on the appropriate channel.

RC releases are marked `--prerelease` on GitHub, skip Discord, and skip the Homebrew formula bump. Stable releases do all three.

**Publish is gated on packaging.** A `verify-package` matrix job sits between `build` and `release` (in both [release.yml](../.github/workflows/release.yml) and [nightly.yml](../.github/workflows/nightly.yml)): it replays recorded golden tapes against the built per-OS artifact — deterministic, offline, no API key — and a broken package (SEA injection, asset vendoring, boot, config-dir) fails the replay and blocks the release. The Velopack install/uninstall smoke (Windows) — install → replay the installed binary → uninstall — is also **blocking** (validated end-to-end via `test-build.yml`), so a broken installer blocks publish too. Full mechanics in [e2e-harness.md](e2e-harness.md#packaged-artifact-replay-gate-release--nightly-ci).

**What that gate does *not* cover.** Both gates drive the binary via `replay-golden --binary`, which bypasses `checkTerminal()` and never makes a live provider call — so the real launch path and every live-auth path are unexercised, and a green `verify-package` says nothing about either. That is what [pre-cut verification](#pre-cut-verification-the-install-method-smoke-test) is for; don't read a green gate as "the packaged app works."

## Release-list hygiene

The release UI is kept lean so humans can scan it:

- **Nightly** — exactly one release ever exists. Each nightly run purges every release whose tag is `nightly` or starts with `nightly-` (catches both the rolling release and any orphan drafts from earlier cycles), then publishes a single rolling `nightly` release with the day's full notes and artifacts. Dated `nightly-*` *tags* remain in git for `git checkout`/changelog reproducibility and are pruned at 30 days.
- **RC** — every RC in an in-flight cycle stays visible (rc.1, rc.2, …) so testers can compare. They all vanish the moment the matching stable ships.
- **Stable** — `v*` releases accumulate forever. Cutting `v$X.$Y.$Z` deletes any `v$X.$Y.$Z-rc.*` releases (their tags stay in git for reproducibility) but never touches releases for other versions.

## Velopack channel notes

- `vpk pack --channel <name>` produces `releases.<name>.json` and `assets.<name>.json` alongside the installer. These are uploaded as release assets and form the auto-update manifest the installed app polls.
- An installer's channel is baked in at install time. The auto-updater **never** changes channels — moving from stable to nightly (or vice versa) requires an uninstall + reinstall.
- The Windows Terminal portable bundle is pinned by SHA256 in [release.yml](../.github/workflows/release.yml), [nightly.yml](../.github/workflows/nightly.yml), and [test-build.yml](../.github/workflows/test-build.yml). Bump all three together when updating `WT_VERSION`.

## Homebrew

The Homebrew tap (`octopollux/homebrew-mv-tap`) currently tracks **nightly** only — the formula is overwritten on each nightly build by [nightly.yml](../.github/workflows/nightly.yml). A stable formula split is planned post-1.0; until then, `brew install octopollux/mv-tap/machine-violet` gets nightlies despite the stable release body advertising it.
