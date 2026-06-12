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

Write-Host "Installing $($setup.Name) ..."
& $setup.FullName --silent
# Velopack may auto-launch the app post-install; settle, then stop any instance
# so it can't hold the install dir or hang the runner.
Start-Sleep -Seconds 10
Get-Process MachineViolet -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

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
