#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 7 ]; then
  echo "Usage: $0 <stable|nightly> <version> <darwin-url> <darwin-sha> <linux-url> <linux-sha> <output>" >&2
  exit 2
fi

CHANNEL="$1"
VERSION="$2"
DARWIN_URL="$3"
DARWIN_SHA="$4"
LINUX_URL="$5"
LINUX_SHA="$6"
OUTPUT="$7"

case "$CHANNEL" in
  stable)
    CLASS_NAME="MachineViolet"
    CONFLICT_NAME="machine-violet-nightly"
    VERSION_SCHEME="  version_scheme 1"
    ;;
  nightly)
    CLASS_NAME="MachineVioletNightly"
    CONFLICT_NAME="machine-violet"
    VERSION_SCHEME=""
    ;;
  *)
    echo "Unknown Homebrew channel: $CHANNEL" >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname "$OUTPUT")"

cat > "$OUTPUT" <<FORMULA
class ${CLASS_NAME} < Formula
  desc "AI Dungeon Master for tabletop RPGs"
  homepage "https://github.com/octopollux/machine-violet"
  version "${VERSION}"
${VERSION_SCHEME}
  license "MIT"

  conflicts_with "${CONFLICT_NAME}", because: "both install the machine-violet executable"

  on_macos do
    on_arm do
      url "${DARWIN_URL}"
      sha256 "${DARWIN_SHA}"
    end
  end

  on_linux do
    on_intel do
      url "${LINUX_URL}"
      sha256 "${LINUX_SHA}"
    end
  end

  def install
    # Install the whole extracted tree. The binary resolves prompts/,
    # themes/, systems/, worlds/, personalities/, config/, assets/,
    # the vendored codex/ runtime and node_modules/ (sharp) relative
    # to its own location, and reads version.json for --version.
    # Cherry-picking a subset silently breaks those at runtime —
    # notably ChatGPT sign-in, which spawns codex/vendor/.../bin/codex.
    libexec.install Dir["*"]

    chmod 0755, libexec/"MachineViolet"
    # Expose as lowercase \`machine-violet\` for CLI convention.
    # A symlink (not write_env_script) keeps process.execPath pointing
    # into libexec, which is what the colocated asset + codex lookups
    # resolve against.
    bin.install_symlink libexec/"MachineViolet" => "machine-violet"
  end

  test do
    assert_match "MachineViolet", shell_output("#{bin}/machine-violet --version")
  end
end
FORMULA
