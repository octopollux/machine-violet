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
4. The push of `v*` triggers [release.yml](../.github/workflows/release.yml), which builds Win/macOS/Linux, signs Windows via Velopack + Azure Trusted Signing, **replays the golden corpus against each packaged binary** (the `verify-package` gate), generates AI release notes (Haiku), and creates the GitHub release on the appropriate channel.

RC releases are marked `--prerelease` on GitHub, skip Discord, and skip the Homebrew formula bump. Stable releases do all three.

**Publish is gated on packaging.** A `verify-package` matrix job sits between `build` and `release` (in both [release.yml](../.github/workflows/release.yml) and [nightly.yml](../.github/workflows/nightly.yml)): it replays recorded golden tapes against the built per-OS artifact — deterministic, offline, no API key — and a broken package (SEA injection, asset vendoring, boot, config-dir) fails the replay and blocks the release. The optional Velopack install/uninstall smoke (Windows) is report-only until validated via `test-build.yml`. Full mechanics in [e2e-harness.md](e2e-harness.md#packaged-artifact-replay-gate-release--nightly-ci).

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
