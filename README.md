# Machine Violet

[![Discord](https://img.shields.io/discord/1483251600071065691?logo=discord&label=Discord&color=5865F2)](https://discord.gg/dDbGZrecvX)

An agentic AI Dungeon Master that runs any tabletop RPG in a terminal.

Machine Violet is a complete game engine: it narrates, inhabits NPCs, tracks state, rolls dice, manages scenes, and maintains a living campaign filesystem — all from your terminal. The DM is opinionated, surprising, and plays to win. You just need an Anthropic API key.

## Install

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/octopollux/machine-violet/main/scripts/install.ps1 | iex
```

**macOS / Linux**:
```bash
curl -fsSL https://raw.githubusercontent.com/octopollux/machine-violet/main/scripts/install.sh | bash
```

Then run `machine-violet` in your terminal. You'll need an [Anthropic API key](https://console.anthropic.com/) — add it from the main menu on first launch.

> **Terminal requirement:** Use Windows Terminal, iTerm2, or any modern terminal with ANSI support. cmd.exe and PowerShell ISE are not supported.

## What it does

- **Runs any TTRPG.** Bundled rule cards for D&D 5e, FATE Accelerated, Ironsworn, Breathless, Charge, 24XX, Cairn — or play freeform with no system at all.
- **Persistent campaign state.** Characters, locations, factions, and lore are markdown files with wikilinks. The campaign transcript is the knowledge backbone.
- **Mechanical delegation.** Dice rolls, action resolution, character sheets, and bookkeeping are handled by fast Haiku subagents — the DM focuses on narrative.
- **Scene-driven architecture.** Scene transitions fire ticking clocks, offscreen consequences, and context compaction. The DM surprises itself.
- **Git-backed recovery.** Auto-commits at scene boundaries. Crash mid-session? Resume exactly where you left off.

## Development

```bash
npm install
npx tsx src/index.tsx          # launch (needs ANTHROPIC_API_KEY in .env)
npm run check                  # lint + tests + coverage
npm run dist                   # build standalone binary (requires Bun)
```

See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and contribution guidelines. Full documentation lives in [docs/](docs/index.md).

## Cost

Machine Violet uses the Claude API. The DM runs on Opus ($15/$75 per MTok input/output); mechanical subagents run on Haiku ($0.25/$1.25 per MTok). A typical session uses 50k–200k input tokens depending on scene complexity. Set `"large": "claude-sonnet-4-5-20250929"` in `dev-config.json` to use Sonnet for the DM during development.

## License

MIT
