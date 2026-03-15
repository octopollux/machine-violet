#Requires -Version 5.1
<#
.SYNOPSIS
  Install or update Machine Violet on Windows.

.DESCRIPTION
  Downloads the latest release from GitHub, extracts to %LOCALAPPDATA%\machine-violet,
  and adds the install directory to the user PATH.

.PARAMETER Version
  Specific version to install (e.g. "1.0.0"). Defaults to latest.
#>
param(
  [string]$Version
)

$ErrorActionPreference = "Stop"
$repo = "Orthodox-531/machine-violet"
$installDir = Join-Path $env:LOCALAPPDATA "machine-violet"

Write-Host ""
Write-Host "  Machine Violet Installer" -ForegroundColor Cyan
Write-Host ""

# Determine version to install
if ($Version) {
  $tag = "v$Version"
  $releaseUrl = "https://api.github.com/repos/$repo/releases/tags/$tag"
} else {
  $releaseUrl = "https://api.github.com/repos/$repo/releases/latest"
}

Write-Host "  Fetching release info..." -NoNewline
try {
  $release = Invoke-RestMethod -Uri $releaseUrl -Headers @{ Accept = "application/vnd.github+json" }
  $tag = $release.tag_name
  $version = $tag -replace '^v', ''
  Write-Host " $tag" -ForegroundColor Green
} catch {
  Write-Host " failed" -ForegroundColor Red
  Write-Host "  Could not fetch release from GitHub. Check your internet connection."
  exit 1
}

# Find the Windows asset
$asset = $release.assets | Where-Object { $_.name -match "windows" -and $_.name -match "\.zip$" } | Select-Object -First 1
if (-not $asset) {
  Write-Host "  No Windows zip found in release $tag" -ForegroundColor Red
  exit 1
}

# Download
$zipPath = Join-Path $env:TEMP "machine-violet-$version.zip"
Write-Host "  Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..." -NoNewline
try {
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing
  Write-Host " done" -ForegroundColor Green
} catch {
  Write-Host " failed" -ForegroundColor Red
  Write-Host "  Download error: $_"
  exit 1
}

# Extract
Write-Host "  Installing to $installDir..." -NoNewline
try {
  # Remove old installation but preserve .env if present
  $envBackup = $null
  $envPath = Join-Path $installDir ".env"
  if (Test-Path $envPath) {
    $envBackup = Get-Content $envPath -Raw
  }

  if (Test-Path $installDir) {
    Remove-Item $installDir -Recurse -Force
  }

  Expand-Archive -Path $zipPath -DestinationPath $installDir -Force

  # If the zip contains a single subdirectory, move its contents up
  $children = Get-ChildItem $installDir
  if ($children.Count -eq 1 -and $children[0].PSIsContainer) {
    $innerDir = $children[0].FullName
    Get-ChildItem $innerDir | Move-Item -Destination $installDir
    Remove-Item $innerDir -Force
  }

  # Restore .env
  if ($envBackup) {
    Set-Content -Path $envPath -Value $envBackup -NoNewline
  }

  Write-Host " done" -ForegroundColor Green
} catch {
  Write-Host " failed" -ForegroundColor Red
  Write-Host "  Extract error: $_"
  exit 1
}

# Clean up zip
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

# Add to PATH if not already present
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
  Write-Host "  Adding to PATH..." -NoNewline
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
  $env:Path = "$env:Path;$installDir"
  Write-Host " done" -ForegroundColor Green
  Write-Host ""
  Write-Host "  NOTE: Restart your terminal for PATH changes to take effect." -ForegroundColor Yellow
} else {
  Write-Host "  Already in PATH." -ForegroundColor DarkGray
}

# Verify
$exePath = Join-Path $installDir "machine-violet.exe"
if (Test-Path $exePath) {
  Write-Host ""
  $versionOutput = & $exePath --version 2>&1
  Write-Host "  Installed: $versionOutput" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Run 'machine-violet' to start!" -ForegroundColor Cyan

  # Terminal compatibility hint
  Write-Host ""
  Write-Host "  Tip: Use Windows Terminal for the best experience." -ForegroundColor DarkGray
  Write-Host "       cmd.exe and PowerShell ISE are not supported." -ForegroundColor DarkGray
} else {
  Write-Host ""
  Write-Host "  Warning: executable not found at expected path." -ForegroundColor Yellow
  Write-Host "  Check $installDir" -ForegroundColor Yellow
}

Write-Host ""
