# Theme Editor

Browser-based live previewer for Machine Violet's terminal **themes**. It renders
`.theme` and `.player-frame` assets exactly the way the TUI does — by importing the
real engine renderer (`packages/client-ink/src/tui/themes/*`) — so what you see in
the browser is what the game draws. Tweak color keys, watch the conversation frame,
modals, and player pane update across every style variant, then copy the result
back into the asset file.

## Quick Start

```bash
cd tools/theme-editor
npm install
npm run dev:server   # Express API on :3998 (serves the asset files)
npm run dev:client   # Vite dev server on :5198 (proxies /api to :3998)
```

Open http://localhost:5198 in your browser. (`npm run dev` starts both at once, but
uses a bash `&`; on Windows run the two commands in separate terminals, or use the
cross-platform launcher `node scripts/dev.js`.)

## What it shows

- The **conversation frame**, a **modal**, and the **player pane**, rendered from
  the selected `.theme` / `.player-frame` with sample content.
- All style **variants** — `exploration`, `combat`, `ooc`, `levelup`, `dev` — so you
  can check variant color overrides at a glance.
- Editable color keys with live re-render. Use the editor to dial in colors, then
  **copy the updated source** and paste it back into the asset file by hand.

## Editing workflow

The server is **read-only** — it never writes asset files. The loop is:

1. Pick a theme in the UI; edit color keys / source until it looks right.
2. Copy the generated theme source from the editor.
3. Paste it into the matching file under
   `packages/client-ink/src/tui/themes/assets/<name>.theme`.

Assets are discovered from `packages/client-ink/src/tui/themes/assets/` (both
`.theme` and `.player-frame` files).

## Validating assets

To parse + resolve every asset and surface broken art, bad config keys, or unknown
presets/gradients/harmonies before the TUI tries to render them:

```bash
# from the repo root
node --import tsx/esm tools/theme-editor/scripts/validate.mjs
```

Exit code equals the number of files that failed, so it doubles as a CI check.

## Ports

| Service | Port | Notes |
|---|---|---|
| Express API | 3998 | Override with `PORT=…`. |
| Vite client | 5198 | Pinned to match the `/api` proxy in `vite.config.ts`. |

The two ports are coupled by the Vite proxy — change them together.
