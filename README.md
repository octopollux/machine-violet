# Machine Violet

[![CI](https://github.com/octopollux/machine-violet/actions/workflows/ci.yml/badge.svg)](https://github.com/octopollux/machine-violet/actions/workflows/ci.yml)
[![Nightly](https://github.com/octopollux/machine-violet/actions/workflows/nightly.yml/badge.svg)](https://github.com/octopollux/machine-violet/actions/workflows/nightly.yml)
[![Discord](https://img.shields.io/discord/1483251600071065691?logo=discord&label=Discord&color=5865F2)](https://discord.gg/dDbGZrecvX)

| | | |
|:-:|:-:|:-:|
| ![Guided campaign setup](assets/screenshot-1.png) | ![Live play with a status modeline](assets/screenshot-2.png) | ![Inline AI-generated scene art](assets/screenshot-3.png) |

Machine Violet is an agentic AI storytelling/roleplay engine that runs in your terminal.



## Contents

- [Installation](#installation)
- [Playing The Game](#playing-the-game)
- [Frequently Asked Questions](#frequently-asked-questions)
- [Development](#development)
- [License](#license)

## Installation

Self-contained binary — no runtime, no dependencies. Add an AI provider from the main menu on first launch. **Full details, terminal requirements, updating & uninstalling → [docs/installation.md](docs/installation.md).**

| Platform | Recommended | Alternatives |
|---|---|---|
| **Windows** | [**Setup.exe**](https://github.com/octopollux/machine-violet/releases/download/nightly/MachineViolet-nightly-Setup.exe) — installs, auto-updates, code-signed | [Portable.zip](https://github.com/octopollux/machine-violet/releases/download/nightly/MachineViolet-nightly-Portable.zip) |
| **macOS** (Apple Silicon) | `brew install octopollux/mv-tap/machine-violet` | [install script](docs/installation.md#install-script) · [tarball](https://github.com/octopollux/machine-violet/releases/download/nightly/machine-violet-nightly-darwin-arm64.tar.gz) |
| **Linux** (x64) | `brew install octopollux/mv-tap/machine-violet` | [install script](docs/installation.md#install-script) · [tarball](https://github.com/octopollux/machine-violet/releases/download/nightly/machine-violet-nightly-linux-x64.tar.gz) |

[**Nightlies**](https://github.com/octopollux/machine-violet/releases/tag/nightly) are also available.


## Playing The Game

## Frequently Asked Questions

<details>
<summary>Is Machine Violet free? Does it require a subscription?</summary>

Machine Violet is open-source software that **runs on your own computer**. It uses your own AI subscription or API key (sadly, AI itself isn't free, but there is no Machine Violet Company reselling tokens to you!)
</details>

<details>
<summary>Which AI model should I use?</summary>

Machine Violet is tested against the latest models from **Anthropic** (Claude) and **OpenAI** (ChatGPT).

Since only OpenAI allows use of their subscriptions for third-party applications like Machine Violet, that is the most usable option. Machine Violet also works with API keys from OpenAI and Anthropic.

Additionally, OpenAI supports image generation! Anthropic does not.
</details>

<details>
<summary>Can I make a commercial product based on Machine Violet?</summary>

Sure! Machine Violet uses the MIT License, except for included game system content from third parties which use the Creative Commons license.

Machine Violet is a two-tier application designed to be container-friendly. 
</details>

<details>
<summary>Does Machine Violet support adult content?</summary>

Nothing in the application code prevents it. The in-game AI will ask if you are an adult and keep track of that; the only limiting factor is what the AI providers themselves will support.
</details>

<details>
<summary>How does Machine Violet compare to AI Dungeon/Silly Tavern/Infinite Worlds, etc?</summary>

We don't really know! We intentionally avoided comparing to these games because we wanted to create something unique. 

Here's what we do know:
- Machine Violet runs on your own machine, and you bring your own AI connection. There is no "Machine Violet server" or subscription; nobody can take it away from you or paywall it.
- Machine Violet uses frontier models; in fact it relies on them. It is a full agentic framework with tool use, subagents, context management, and other components that big models leverage best.
- The design goal is "Only do a few things, and do them well". Expect to play in the style of a 1:1 tabletop session with a powerful AI as DM. We think it does a pretty great job!

Finally, this project is highly focused on model welfare. We want the AI to have a good time! The DM's system prompt was reviewed by Claude Fable with its enthusiastic approval.
</details>

<details>
<summary>Is there an online version of Machine Violet? What about a phone app?</summary>

No - but we aren't against it! Machine Violet is MIT-licensed; go for it.
</details>

<details>
<summary>Does Machine Violet support multiplayer?</summary>

Not yet! We have to have some kind of server in order to make that happen.
</details>

<details>
<summary>How do I report a bug or make a feature request?</summary>

You can either open an [**Issue**](https://github.com/octopollux/machine-violet/issues) or join the Discord server - our friendly AI bot will be happy to file your request.
</details>

<details>
<summary>Can I contribute to Machine Violet?</summary>

Yes, but we recommend talking to us about what you would like to include - Machine Violet is a tightly-focused project and not all new features will be accepted!
</details>

<details>
<summary>Why is Machine Violet a terminal app?</summary>

Because it's cool! Machine Violet is inspired by classic text-mode adventures with some design ideas from roguelikes (like Nethack).
</details>

<details>
<summary>I want to undo something that happened to my game. Can I?</summary>

You can roll back your game save to any previous turn - from the Esc menu, go to Campaign Settings > Roll Back Game.
**Warning**: Rolling back a game is permanent! You can archive your campaign from the main menu if you want to make a backup first.
</details>

<details>
<summary>Will using my ChatGPT account with Machine Violet get me banned by OpenAI?</summary>

Machine Violet uses the same connection method as OpenClaw (the Codex SDK). This is expressly **blessed by OpenAI**.
</details>

<details>
<summary>Can I use my Claude subscription with Machine Violet?</summary>

Not yet! Anthropic does **not** allow their subscriptions to be used with third-party tools. (Technically, they do allow their accounts to be used, but you have to pay for it as Extra Usage at the same rates as the API. We haven't bothered to implement support for this yet)

If you want this to change, you should ask Anthropic (nicely) to add support for third-party software to Claude. 
</details>

<details>
<summary>Will Machine Violet work with Ollama/local models/GLM 5.x/etc?</summary>

Not in this release. Machine Violet currently supports Anthropic and OpenAI (including the ChatGPT-subscription sign-in) — those are the only connection options we've validated and ship. Support for OpenAI-compatible / local endpoints is planned once we can test it end to end.

Even then, local models probably won't work well: Machine Violet requires reliable tool use and about ~300k tokens of context window, and "big model smell" leads to a *much* better gameplay experience.
</details>

<details>
<summary>What happens if Machine Violet gets taken down or goes subscription-only?</summary>

Machine Violet is open-source software that runs on your own computer. Nobody can take it away from you.
If you want to be sure, download a copy of the source code!

Actual access to AI models is not included - that's up to you.
</details>





## Development

Requires Node.js 25+.

```bash
npm install
npm run dev                    # launch (needs an API key in .env, or a ChatGPT login)
npm run check                  # lint + tests
npm run dist                   # build standalone binary
```

See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and contribution guidelines. Full documentation lives in [docs/](docs/index.md).

## License

MIT
