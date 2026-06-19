# Image style examples

One worked sample render per `.mvstyle` style variant, so style-to-seed
assignment is a *look*, not a guess. When wiring a seed to an art direction
(`<!--include:Image.VariantName-->`), open the matching example here to see what
that style actually produces.

## Convention

- One file per variant, named **`<VariantTag>.example.png`**, where
  `<VariantTag>` is the style file in [`../Image/`](../Image/) (e.g.
  `Risograph.example.png` ↔ `Image/Risograph.mvstyle`, selected via
  `Image.Risograph`).
- Full resolution on purpose — the whole point is to judge fine detail and the
  "bored-model" tic at native size.
- Each was rendered through `packages/test-harness/bin/style-probe.ts` against a
  single scene with a character reference, then human-eyeballed before its
  variant was banked. To (re)generate one, run style-probe with that variant's
  style line and copy the result here under the convention name.

## Not shipped

These are an authoring aid, never read at runtime, so they are **excluded from
the compiled binary** — `scripts/build-dist.js` skips this directory when
copying `prompts/` into the SEA (`exclude: /[\\/]ImageStyleExample(?:[\\/]|$)/`).
They live in the repo only.
