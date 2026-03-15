#!/usr/bin/env bash
#
# Install or update Machine Violet on macOS/Linux.
# Downloads the latest release from GitHub, extracts to ~/.local/lib/machine-violet,
# and symlinks the binary to ~/.local/bin/.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/octopollux/machine-violet/main/scripts/install.sh | bash
#   # or with a specific version:
#   curl -fsSL ... | bash -s -- --version 1.0.0

set -euo pipefail

REPO="octopollux/machine-violet"
INSTALL_DIR="${HOME}/.local/lib/machine-violet"
BIN_DIR="${HOME}/.local/bin"
VERSION=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "  Machine Violet Installer"
echo ""

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)      echo "  Unsupported OS: $OS"; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             echo "  Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Fetch release info
if [ -n "$VERSION" ]; then
  RELEASE_URL="https://api.github.com/repos/$REPO/releases/tags/v$VERSION"
else
  RELEASE_URL="https://api.github.com/repos/$REPO/releases/latest"
fi

printf "  Fetching release info..."
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" "$RELEASE_URL")" || {
  echo " failed"
  echo "  Could not fetch release from GitHub. Check your internet connection."
  exit 1
}

TAG="$(echo "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
echo " $TAG"

# Find the platform asset
ASSET_URL="$(echo "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*'"$PLATFORM"'[^"]*\.tar\.gz"' | head -1 | cut -d'"' -f4)"
if [ -z "$ASSET_URL" ]; then
  echo "  No $PLATFORM tar.gz found in release $TAG"
  exit 1
fi

ASSET_NAME="$(basename "$ASSET_URL")"

# Download
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

printf "  Downloading %s..." "$ASSET_NAME"
curl -fsSL -o "$TMPDIR/archive.tar.gz" "$ASSET_URL" || {
  echo " failed"
  exit 1
}
echo " done"

# Extract
printf "  Installing to %s..." "$INSTALL_DIR"

# Preserve .env if present
ENV_BACKUP=""
if [ -f "$INSTALL_DIR/.env" ]; then
  ENV_BACKUP="$(cat "$INSTALL_DIR/.env")"
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPDIR/archive.tar.gz" -C "$INSTALL_DIR" --strip-components=1 2>/dev/null \
  || tar -xzf "$TMPDIR/archive.tar.gz" -C "$INSTALL_DIR"

# Restore .env
if [ -n "$ENV_BACKUP" ]; then
  printf "%s" "$ENV_BACKUP" > "$INSTALL_DIR/.env"
fi

chmod +x "$INSTALL_DIR/machine-violet"
echo " done"

# Symlink to bin
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/machine-violet" "$BIN_DIR/machine-violet"

# Check if BIN_DIR is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo ""
  echo "  NOTE: $BIN_DIR is not in your PATH."
  echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo ""
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi

# Verify
if [ -x "$INSTALL_DIR/machine-violet" ]; then
  echo ""
  VERSION_OUTPUT="$("$INSTALL_DIR/machine-violet" --version 2>&1 || true)"
  echo "  Installed: $VERSION_OUTPUT"
  echo ""
  echo "  Run 'machine-violet' to start!"
fi

echo ""
