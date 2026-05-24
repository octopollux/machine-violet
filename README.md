# Machine Violet

[![Discord](https://img.shields.io/discord/1483251600071065691?logo=discord&label=Discord&color=5865F2)](https://discord.gg/dDbGZrecvX)
[![CI](https://github.com/octopollux/machine-violet/actions/workflows/ci.yml/badge.svg)](https://github.com/octopollux/machine-violet/actions/workflows/ci.yml)
[![Nightly](https://github.com/octopollux/machine-violet/actions/workflows/nightly.yml/badge.svg)](https://github.com/octopollux/machine-violet/actions/workflows/nightly.yml)

| | | |
|:-:|:-:|:-:|
| ![Screenshot 1](assets/screenshot-1.png) | ![Screenshot 2](assets/screenshot-2.png) | ![Screenshot 3](assets/screenshot-3.png) |

Machine Violet is an agentic AI storytelling/roleplay engine that runs in your terminal.

## What it does

- **Build your story.** Interactively build a narrative with a friendly game setup agent, and then explore it with the help of a powerful AI storyteller.
- **Create a compendium.** Characters, locations, objectives, factions, and lore are compiled into a wiki-linked library that keeps the story alive.
- **Rich support for game mechanics.** Full support for dice, decks, maps, clocks, RPG rules, and more as agentic tools.
- **Dozens of starter seeds.** Pick a prompt and go — from low-stakes slice-of-life to amnesia thrillers to old-magic-versus-engineered-magic — or build from scratch.

## Bring your own AI

Machine Violet works with whichever AI provider you already pay for:

- **ChatGPT Plus / Pro / Business / Enterprise** — sign in with your existing subscription. No API credits required. Uses OpenAI's official Codex app-server for backend API calls and live rate-limit reporting.
- **Anthropic API** — Claude Opus / Sonnet / Haiku via [console.anthropic.com](https://console.anthropic.com/).
- **OpenAI API** — GPT-5.5 and friends via an OpenAI API key.
- **OpenRouter** — one key, many models.
- **Custom endpoints** — any OpenAI-compatible base URL (self-hosted, Azure, etc.).

Add a connection from the main menu on first launch. Mix providers across tiers if you want — e.g., a premium model for the storyteller and a cheaper one for mechanical subagents.

## Install

### Windows

**Installer (recommended)** — Download [**`MachineViolet-nightly-Setup.exe`**](https://github.com/octopollux/machine-violet/releases/download/nightly/MachineViolet-nightly-Setup.exe) and run it. Adds a Start Menu shortcut and updates itself in the background. Code-signed.

**Portable** — Download [**`MachineViolet-nightly-Portable.zip`**](https://github.com/octopollux/machine-violet/releases/download/nightly/MachineViolet-nightly-Portable.zip), unzip anywhere, run `MachineViolet.exe`.

> Use Windows Terminal (Preview 1.25+) for the best experience. PowerShell ISE is not supported; if launched from bare `cmd.exe` or by double-click, Machine Violet auto-relaunches in Windows Terminal when one is available. The portable zip bundles a copy of Windows Terminal.

### macOS (Apple Silicon) / Linux (x64)

**Homebrew** (easiest):
```bash
brew install octopollux/mv-tap/machine-violet
```
Then run `machine-violet` in your terminal.

**Install script** — downloads the tarball and symlinks `machine-violet` into `~/.local/bin`:
```bash
curl -fsSL https://raw.githubusercontent.com/octopollux/machine-violet/main/scripts/install.sh | bash
```
Then run `machine-violet` in your terminal.

**Tarball (manual)** — grab `machine-violet-nightly-darwin-arm64.tar.gz` or `machine-violet-nightly-linux-x64.tar.gz` from the [latest release](https://github.com/octopollux/machine-violet/releases/tag/nightly), extract, and run `./MachineViolet` from the extracted directory.

## Development

```bash
npm install
npm run dev                    # launch (needs an API key in .env, or a ChatGPT login)
npm run check                  # lint + tests
npm run dist                   # build standalone binary
```

See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and contribution guidelines. Full documentation lives in [docs/](docs/index.md).

## License

MIT
