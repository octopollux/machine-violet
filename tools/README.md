# Developer Tools

Standalone helper apps for working **on** Machine Violet — not part of the shipped
product and not bundled into the launcher. Each is its own npm workspace with its
own `package.json`; `cd` into one and `npm install` before first use.

| Tool | What it does |
|---|---|
| [campaign-explorer](campaign-explorer/README.md) | Real-time web viewer for a campaign's entity files, state JSON, transcripts, and context dumps — watch them update live during gameplay. |
| [theme-editor](theme-editor/README.md) | Browser previewer for `.theme` / `.player-frame` assets, rendered with the real engine renderer; tweak colors and copy the source back. |

> **Docs scope:** these tools are intentionally kept lightweight. A README that
> explains what each is and how to run it is enough — they are exempt from the
> code-and-docs-in-the-same-commit loop in [docs/maintenance.md](../docs/maintenance.md)
> that governs the application packages.
