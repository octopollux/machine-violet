<#
.SYNOPSIS
  Velopack install -> run -> uninstall smoke for the Windows packaged artifact.

.DESCRIPTION
  Installs the Velopack Setup.exe, replays the golden corpus against the
  INSTALLED binary (exercising the real install layout, not just the portable
  payload), then uninstalls. Catches Velopack manifest / install-path / update
  bugs that the portable-zip replay can't.

  NOT validated locally (a real install modifies the machine and the signed
  Setup.exe only exists in CI), so it was validated on a clean runner via a
  test-build.yml dispatch (install -> replay installed binary -> uninstall, all
  green). Now blocking in release/nightly + test-build. See docs/e2e-harness.md.
#>
param(
  [Parameter(Mandatory)][string]$ArtifactDir,
  [Parameter(Mandatory)][string]$RepoRoot
)
$ErrorActionPreference = "Stop"

$setup = Get-ChildItem -Path $ArtifactDir -Filter "MachineViolet-*-Setup.exe" -Recurse | Select-Object -First 1
if (-not $setup) { throw "No MachineViolet-*-Setup.exe found in $ArtifactDir" }

# Velopack writes a completion marker to this log; we anchor on it below rather
# than on a fixed sleep. Baseline the existing match count first so a re-run on a
# non-clean machine (where a prior "completed" line lingers) waits for OUR
# install's marker, not a stale one.
$velopackLog = Join-Path $env:LOCALAPPDATA "velopack\velopack.log"
$completeMarker = "Installation completed successfully!"
$baselineHits = 0
if (Test-Path $velopackLog) {
  $baselineHits = (Select-String -Path $velopackLog -SimpleMatch $completeMarker -ErrorAction SilentlyContinue | Measure-Object).Count
}

Write-Host "Installing $($setup.Name) ..."
& $setup.FullName --silent

# `Setup.exe --silent` RETURNS BEFORE its background install finishes (post-install
# hook + a "kill every running app instance" sweep). A fixed sleep races that work:
# on a slow runner the sleep elapses, we launch the replay's own app instance, and
# Velopack's completion sweep kills it -> the harness's next fetch dies with
# "fetch failed" (nightly run 27864214122). Anchor on the real completion marker
# in the Velopack log instead.
$deadline = (Get-Date).AddSeconds(180)
$installed = $false
while ((Get-Date) -lt $deadline) {
  if (Test-Path $velopackLog) {
    $hits = (Select-String -Path $velopackLog -SimpleMatch $completeMarker -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($hits -gt $baselineHits) { $installed = $true; break }
  }
  Start-Sleep -Milliseconds 500
}
if (-not $installed) { throw "Velopack install did not report '$completeMarker' within 180s (log: $velopackLog)" }

# Velopack auto-launches the app as part of the post-install hook; with the install
# now fully settled, stop any lingering instance so it can't hold the install dir
# or hang the runner before we replay against the installed binary. Poll-and-kill
# until none remain (bounded) rather than sleeping a fixed amount and hoping.
$killDeadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $killDeadline) {
  $procs = Get-Process MachineViolet -ErrorAction SilentlyContinue
  if (-not $procs) { break }
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 250
}

$installRoot = Join-Path $env:LOCALAPPDATA "MachineViolet"
$bin = Join-Path $installRoot "current\MachineViolet.exe"
if (-not (Test-Path $bin)) {
  $found = Get-ChildItem -Path $installRoot -Filter "MachineViolet.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $bin = $found.FullName }
}
if (-not (Test-Path $bin)) { throw "Installed binary not found under $installRoot" }
Write-Host "Replaying goldens against installed binary: $bin"

Push-Location $RepoRoot
try {
  node --import tsx/esm packages/test-harness/bin/replay-golden.ts --binary "$bin"
  $replayExit = $LASTEXITCODE
} finally {
  Pop-Location
}

# Uninstall regardless of replay outcome so the runner is left clean.
$updater = Join-Path $installRoot "Update.exe"
if (Test-Path $updater) {
  Write-Host "Uninstalling ..."
  & $updater --uninstall --silent
  Start-Sleep -Seconds 5
}

if ($replayExit -ne 0) { throw "Replay against the installed binary failed (exit $replayExit)" }
Write-Host "Velopack install smoke passed."
