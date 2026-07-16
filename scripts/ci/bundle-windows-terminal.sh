#!/usr/bin/env bash
#
# Stage the portable Windows Terminal that ships inside the Windows build.
#
# Shared by release.yml, nightly.yml, and test-build.yml. It lived inline in all
# three, drifted, and shipped a layout the app couldn't use: the exe ended up at
# dist/terminal/terminal-<version>/WindowsTerminal.exe while findWindowsTerminal()
# (packages/engine/src/config/terminal-check.ts) probes dist/terminal/
# WindowsTerminal.exe. That probe is an existsSync with a silent fallback to a
# system wt.exe, so the mistake shipped as "the installed app won't launch from
# the Start Menu" rather than as a build failure. One copy now, asserted below.
#
# Run from the repo root, after build-dist.js has populated dist/.
set -euo pipefail

# Preview 1.25+ adds Kitty keyboard protocol support, which fixes
# Backspace/Home/End input corruption on Windows (ConPTY bug).
WT_VERSION="1.25.622.0"
WT_ZIP="Microsoft.WindowsTerminalPreview_${WT_VERSION}_x64.zip"
WT_URL="https://github.com/microsoft/terminal/releases/download/v${WT_VERSION}/${WT_ZIP}"
# Update this hash when bumping WT_VERSION.
WT_SHA256="ba5b75eb769e99221e68fe4bfb3580ed1ade81f24b70334de4cb4742edf1b017"

echo "Downloading Windows Terminal portable ${WT_VERSION}..."
curl -fSL -o wt-portable.zip "$WT_URL"
echo "$WT_SHA256  wt-portable.zip" | sha256sum -c -

# The zip wraps its payload in a single top-level `terminal-<version>/`
# directory, so unzipping straight into dist/terminal/ buries the exe one level
# too deep. Extract aside, then flatten: the exe, `.portable`, and `settings/`
# must be siblings — portable mode only reads the latter two next to the exe.
rm -rf wt-extract
mkdir -p wt-extract dist/terminal
unzip -q wt-portable.zip -d wt-extract

# Locate the exe rather than hardcoding the wrapper name, but bail if it's
# absent: `dirname ""` is `.`, which would turn the mv below into
# `mv ./* dist/terminal/` and sweep up the whole workspace.
WT_EXE="$(find wt-extract -name WindowsTerminal.exe -print -quit)"
test -n "$WT_EXE" || { echo "::error::WindowsTerminal.exe not found in ${WT_ZIP} — layout changed?"; exit 1; }
mv "$(dirname "$WT_EXE")"/* dist/terminal/
rm -rf wt-extract wt-portable.zip

# Enable portable mode (settings stored next to exe, not in %APPDATA%).
touch dist/terminal/.portable

# Seed MV's default terminal config (window size + Ottosson theme).
mkdir -p dist/terminal/settings
cp assets/windows-terminal/settings.json dist/terminal/settings/settings.json

# Include Windows Terminal's MIT license (third-party notice).
if [ -f dist/terminal/LICENSE ]; then
  mv dist/terminal/LICENSE dist/terminal/LICENSE-windows-terminal.txt
fi

# Assert the layout. This is the point of the script: the consuming code fails
# silently, so the packaging step has to be the thing that shouts.
for f in dist/terminal/WindowsTerminal.exe dist/terminal/settings/settings.json dist/terminal/.portable; do
  test -f "$f" || { echo "::error::bundled Windows Terminal layout wrong: missing $f"; exit 1; }
done

echo "Bundled Windows Terminal ${WT_VERSION} ($(du -sh dist/terminal | cut -f1))"
