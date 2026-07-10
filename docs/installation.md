# Installation

Machine Violet ships as a self-contained binary for Windows, macOS (Apple Silicon), and Linux (x64). There's no runtime to install and no dependencies to manage — download it, run it, and add an AI provider from the main menu on first launch.

## Contents

- [Windows](#windows)
  - [Installer (recommended)](#installer-recommended)
  - [Portable](#portable)
  - [Terminal requirements](#terminal-requirements)
- [macOS (Apple Silicon) / Linux (x64)](#macos-apple-silicon--linux-x64)
  - [Homebrew](#homebrew)
  - [Install script](#install-script)
  - [Tarball (manual)](#tarball-manual)
- [Updating](#updating)
- [Uninstalling](#uninstalling)

## Windows

### Installer (recommended)

Download [**`MachineViolet-nightly-Setup.exe`**](https://github.com/octopollux/machine-violet/releases/download/nightly/MachineViolet-nightly-Setup.exe) and run it. It adds a Start Menu shortcut and updates itself in the background. The installer is code-signed.

### Portable

Download [**`MachineViolet-nightly-Portable.zip`**](https://github.com/octopollux/machine-violet/releases/download/nightly/MachineViolet-nightly-Portable.zip), unzip anywhere, and run `MachineViolet.exe`. The portable build does not auto-update — re-download to upgrade.

### Terminal requirements

Use **Windows Terminal (Preview 1.25+)** for the best experience. PowerShell ISE is not supported. If Machine Violet is launched from bare `cmd.exe` or by double-click, it auto-relaunches inside Windows Terminal when one is available. The portable zip bundles a copy of Windows Terminal so it works out of the box.

## macOS (Apple Silicon) / Linux (x64)

### Homebrew

The easiest install. Requires [Homebrew](https://brew.sh/).

```bash
brew install octopollux/mv-tap/machine-violet
```

Then run `machine-violet` in your terminal. Upgrade later with `brew upgrade machine-violet`.

### Install script

Downloads the tarball and symlinks `machine-violet` into `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/octopollux/machine-violet/main/scripts/install.sh | bash
```

Then run `machine-violet` in your terminal. Make sure `~/.local/bin` is on your `PATH`.

### Tarball (manual)

Grab the tarball for your platform from the [latest release](https://github.com/octopollux/machine-violet/releases/tag/nightly):

- macOS (Apple Silicon): `machine-violet-nightly-darwin-arm64.tar.gz`
- Linux (x64): `machine-violet-nightly-linux-x64.tar.gz`

Extract it, then run `./MachineViolet` from the extracted directory.

## Updating

- **Windows installer** — updates automatically in the background; no action needed.
- **Windows portable** — re-download the zip and replace your copy.
- **Homebrew** — `brew upgrade machine-violet`.
- **Install script** — re-run the `curl … | bash` command.
- **Tarball** — download the latest tarball and replace the extracted directory.

## Uninstalling

- **Windows installer** — remove via *Settings → Apps → Installed apps*, or the Start Menu uninstall shortcut.
- **Windows portable** — delete the unzipped folder.
- **Homebrew** — `brew uninstall machine-violet`.
- **Install script / tarball** — delete the `machine-violet` symlink from `~/.local/bin` and the extracted directory.
