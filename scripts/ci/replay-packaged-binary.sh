#!/usr/bin/env bash
#
# Replay the golden corpus against a PACKAGED artifact — the deterministic
# packaged-artifact gate (see docs/e2e-harness.md). Extracts the binary + its
# vendored assets from the per-OS artifact, then drives the SEA binary through
# the recorded full-stack tapes with no API key (MV_E2E + MV_TAPE_MODE=replay,
# wired by the replay runner). Exits non-zero on any mismatch so a broken
# package blocks publish.
#
# Usage: replay-packaged-binary.sh <artifact-dir>
#   Windows: extracts MachineViolet-*-Portable.zip
#   macOS/Linux: extracts machine-violet-*.tar.gz
set -euo pipefail

ARTIFACT_DIR="${1:?usage: replay-packaged-binary.sh <artifact-dir>}"
EXTRACT="$(mktemp -d)"
trap 'rm -rf "$EXTRACT"' EXIT

PORTABLE_ZIP="$(find "$ARTIFACT_DIR" -iname 'MachineViolet-*-Portable.zip' | head -1 || true)"
TARBALL="$(find "$ARTIFACT_DIR" -iname 'machine-violet-*.tar.gz' | head -1 || true)"

if [ -n "$PORTABLE_ZIP" ]; then
  echo "Extracting portable bundle: $PORTABLE_ZIP"
  unzip -q "$PORTABLE_ZIP" -d "$EXTRACT"
  BIN="$(find "$EXTRACT" -iname 'MachineViolet.exe' -type f | head -1 || true)"
elif [ -n "$TARBALL" ]; then
  echo "Extracting tarball: $TARBALL"
  tar xzf "$TARBALL" -C "$EXTRACT"
  BIN="$(find "$EXTRACT" -name 'MachineViolet' -type f | head -1 || true)"
  [ -n "$BIN" ] && chmod +x "$BIN"
else
  echo "::error::No packaged artifact (Portable.zip / tar.gz) found in $ARTIFACT_DIR" >&2
  ls -la "$ARTIFACT_DIR" >&2 || true
  exit 1
fi

if [ -z "$BIN" ] || [ ! -f "$BIN" ]; then
  echo "::error::Could not locate the MachineViolet binary after extraction" >&2
  find "$EXTRACT" -maxdepth 2 -type f >&2 || true
  exit 1
fi

echo "Replaying goldens against packaged binary: $BIN"
node --import tsx/esm packages/test-harness/bin/replay-golden.ts --binary "$BIN"
