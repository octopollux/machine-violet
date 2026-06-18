---
type: reference
title: "Visual-style tag vocabulary (v0)"
description: "The controlled, faceted tag vocabulary shared by style frontmatter and campaign visual-intent — the match-language behind campaign<->style pairing."
---

# Tag vocabulary (v0 — provisional)

These tags are a **controlled vocabulary**, not free-form descriptors. The same
terms describe a style (in its `.mvstyle` frontmatter) *and* a campaign's desired
look (its visual-intent), so the two can be matched. Tag from this list; if a
style needs a concept that isn't here, that's a signal the vocabulary has a gap —
raise it rather than inventing a one-off token.

> **Status:** v0. The `medium`/`register`/`color` facets are stable (near-objective
> categorization). The `mood`/`scene-fit` facets are the taste-laden ones still
> being shaped alongside the Model-D pairing design — expect churn there.

## medium — what kind of image it physically is *(pick 1–2)*

| tag | meaning |
| --- | --- |
| `photographic` | a still photograph; lens/sensor/film as the medium |
| `film-stock` | the look of a specific photographic film emulsion |
| `motion-picture` | a cinema/movie frame (cine cameras, lab grades, anamorphic) |
| `analog-video` | videotape / broadcast / CRT-era electronic video |
| `surveillance` | camera-feed framing (CCTV, bodycam, drone, dashcam) |
| `game-render` | looks like a real-time video-game engine frame |
| `cg-render` | offline 3D/CGI render not tied to a game era |
| `illustration` | drawn / vector / digital illustration |
| `painting` | painted media (oil, gouache, watercolour, fresco, tempera) |
| `printmaking` | a reproduction/print process (riso, screenprint, engraving, woodcut, letterpress) |
| `comic` | comic-book / graphic-novel idiom |
| `animation` | animation cel / animated-feature frame |
| `textile` | woven / tiled / assembled surface (tapestry, mosaic) |

## register — fidelity / how stylized *(pick 1–2)*

| tag | meaning |
| --- | --- |
| `photoreal` | reads as a real photograph/render of the world |
| `stylized` | deliberately non-photoreal but representational |
| `painterly` | visible paint / brush handling |
| `graphic` | flat shapes, bold line, poster-like |
| `lo-fi` | degraded / low-resolution on purpose |
| `retro` | evokes an older era of its *own* medium (PS1 game, 2004 AAA) |
| `vintage` | an aged / antique physical artifact |
| `period` | tied to a specific historical era's look |

## color *(pick 0–2)*

`color` · `black-and-white` · `monochrome` · `high-saturation` · `muted` ·
`warm` · `cool` · `sepia` · `duotone` · `limited-palette`

## mood *(pick 0–2)*

`noir` · `horror` · `dread` · `tense` · `cozy` · `whimsical` · `tender` ·
`glamorous` · `epic` · `nostalgic` · `clinical` · `grim` · `dreamy` · `gritty` ·
`romantic`

## scene-fit — practical pairing hints *(pick 0–2)*

| tag | meaning |
| --- | --- |
| `any-scene` | medium-agnostic; works on most briefs |
| `outdoor-revealing` | needs a colour/light-rich scene to show its signature |
| `interior-friendly` | flatters dark / interior scenes |
| `wide-vista` | built for grand establishing shots |
| `establishing` | scene-setting register |
| `portrait` | flatters a single figure |
| `intimate` | close, character-scale framing |
| `action` | dynamic / kinetic framing |

## flags *(pick 0+)*

| tag | meaning |
| --- | --- |
| `scene-coupled` | the DM-facing Direction steers the scene brief, not just the paint |
| `caption-title-only` | caption must be a place/scene title, never the process name |
| `first-person` | renders from the character's POV |
