---
name: build-mvworld
description: Convert a played Machine Violet campaign into a reusable `.mvworld` seed — bundle its world (NPCs, locations, factions, lore, items, maps, calendar) and recast its narrative as an open-ended starting premise. USE THIS when the user wants to "turn a campaign into a seed/world", "build a .mvworld", "export this campaign as a starting world", "make a seed from my game", or hands you a campaign path, an archived campaign `.zip`, or a diagnostic `.mvdiag` and asks for a world file. A brain-in-the-loop authoring task — you read the campaign and write the seed by hand; there is no automated exporter.
allowed-tools: Read, Write, Bash, Glob, Grep
---

# Build a `.mvworld` from a played campaign

You are converting a **played campaign** (a specific story that happened) into a
**seed** (an open-ended starting point others can play). This is a *projection*,
not a copy: you keep the standing **world**, drop the **episodic record**, and
recast the situation as a forward-looking premise.

There is **no automated exporter** — you author the `.mvworld` by hand. Your
judgement is the tool. The engine's importer (`materializeWorldContent` in
[`packages/engine/src/agents/world-builder.ts`](../../../packages/engine/src/agents/world-builder.ts))
unpacks whatever you write directly to disk at campaign creation, *without*
routing it through the setup agent's context.

**Schema is canonical.** Read [`docs/format-spec.md` §10](../../../docs/format-spec.md)
and [`packages/shared/src/types/world.ts`](../../../packages/shared/src/types/world.ts)
before writing. A complete worked example ships at
[`worlds/the-salt-wedding.mvworld`](../../../worlds/the-salt-wedding.mvworld) —
copy its shape.

---

## Step 1 — Get the campaign files in front of you

Three source types. All resolve to the same campaign directory tree
([`docs/format-spec.md` §2](../../../docs/format-spec.md)).

### A. Live path on disk
A campaign directory under `<homeDir>/campaigns/<slug>/`. Just read it in place.
On Windows the home dir is `%USERPROFILE%\Documents\.machine-violet\`; macOS
`~/Documents/.machine-violet/`; Linux `~/.local/share/.machine-violet/`.

### B. Archived campaign (`.zip`)
Produced by the in-app Archive action → `archivedcampaigns/<CampaignName>.zip`.
It is a plain zip of the **whole** campaign dir, **including `.git/`**. Unzip to
a scratch dir:

```bash
mkdir -p /tmp/mvworld-src && cd /tmp/mvworld-src && unzip -o "<path>/<Name>.zip"
```

### C. Diagnostic export (`.mvdiag`)
Produced by the in-game diagnostics command →
`<homeDir>/diagnostics/<slug>-<timestamp>.mvdiag`. Also a plain zip (any unzip
tool reads it). Layout differs from B:
- `campaign/…` — the campaign tree (its `.git/` is **excluded**; working-tree
  files are all present)
- `.debug/…` — engine logs (ignore for world-building)
- `manifest.json` — origin metadata (ignore)

```bash
mkdir -p /tmp/mvworld-src && cd /tmp/mvworld-src && unzip -o "<path>/<slug>-<ts>.mvdiag"
# the campaign you care about is under ./campaign/
```

> The `.git/` history (present in A and B, absent in C) is **not** needed —
> the working-tree files are the current world. Don't mine commit history.

---

## Step 2 — Read the world, not the story

Walk the campaign and separate the two kinds of data:

| Read it (→ world) | Skip it (→ the played story) |
|---|---|
| `characters/*.md` — **NPCs only** | `characters/<the PC>.md` — the old player character |
| `locations/*/index.md` + map JSON | `campaign/scenes/**` — transcripts, summaries |
| `factions/*.md` | `campaign/log.json` — episodic scene-by-scene record |
| `lore/*.md` | `campaign/compendium.json` — player-learned knowledge |
| `items/*.md` | `campaign/session-recaps/**` |
| `rules/*.md` (if custom) | `state/conversation.json`, `state/display-log.md` |
| `state/maps.json` | `state/combat.json`, `state/objectives.json` (resolved plot) |
| `state/clocks.json` calendar (epoch only) | `config.json` players/usage/recovery |
| `config.json`: `system`, `genre`, `mood`, `difficulty` | |

Identify the PC by cross-referencing `config.json` → `players[].character`. Every
*other* character file is an NPC and is fair game.

**Read entity bodies for their DM-facing truth.** NPC files carry dispositions
and secrets in their body/front matter — that's exactly what a seed should
preserve so a *new* player can rediscover them.

---

## Step 3 — Write the `.mvworld`

A single JSON file, `worlds/<slug>.mvworld` (bundled) or dropped into the user's
`<homeDir>/worlds/` (imported). Map fields per
[`world.ts`](../../../packages/shared/src/types/world.ts):

**Identity & config** — `format`/`version` (literal `"machine-violet-world"`/`1`),
`name`, `summary` (one-sentence hook), `genres`, and optionally `system`,
`mood`, `difficulty`, `campaign_scope`, `calendar_display_format`,
`dm_personality`.

**`detail`** (DM-only, never shown to the player) — this is where the
*projection* happens. Do **not** transcribe what happened. Instead:
- State the **standing situation** as a fresh starting point.
- Recast resolved plot as latent tension or open questions.
- Add a "crucial question (DM only)" with 2-3 secret directions, the way the
  bundled seeds do (see [`worlds/the-salt-wedding.mvworld`](../../../worlds/the-salt-wedding.mvworld)
  or [`worlds/three-histories.mvworld`](../../../worlds/three-histories.mvworld)).
- Include pacing/tone guidance.

**`suboptions`** (player-facing) — optional structured starting choices (e.g.
"Who are you to this?"). Each shapes the new player's entry into the world.

**`entities`** — keyed by category then slug. Each entity is
`{ title, frontMatter, body }`, mapping 1:1 to an on-disk entity file. **Include
NPCs; never include the old PC** (the importer skips any `type: PC` entity, but
don't author one in the first place). Slugs are kebab-case, articles stripped
("The City" → `city`). Wikilinks in bodies use `[[Display Name]]`.

**`maps`** — keyed by map ID, same schema as
[`docs/format-spec.md` §4.3](../../../docs/format-spec.md). Seed verbatim.

**`rules`** — only if the campaign had custom rule cards; keyed by slug, value is
the full rule-card markdown.

**`calendar`** — `{ current, epoch, display_format }`. Carry the **epoch** label;
reset/choose `current` as a sensible starting time (no alarms — those are
play-state).

### Do NOT include
- **`compendium`** — it's the *player's* learned knowledge. A seed's player knows
  nothing; pre-loading it spoils discovery and misinforms the DM. Omit entirely.
- **The PC character sheet** — created fresh during chargen.
- **Transcripts, logs, recaps, conversation, resolved objectives** — episodic.

---

## Step 4 — Validate

1. **Schema**: bundled seeds are strictly validated by the build —
   `npx vitest run packages/engine/src/config/world-loader.test.ts`. For an
   imported world dropped in `<homeDir>/worlds/`, the loader validates leniently
   (bad files are skipped with a warning).
2. **Round-trip the materializer**: the importer is unit-tested in
   [`packages/engine/src/agents/world-builder.test.ts`](../../../packages/engine/src/agents/world-builder.test.ts) —
   if you changed the schema or importer, run it. To sanity-check *your* file's
   inline content, eyeball it against the expectations there.
3. **Boot & play it**: select the world in New Campaign and confirm the NPCs/
   locations show up and the opening scene reads right. Use the `play` skill
   (`mvplay`) — it's the only way to know the seed actually plays. A bundled
   world (in `worlds/`) is selectable in `npm run dev`; an imported one must sit
   in `<homeDir>/worlds/`.

---

## Notes

- **Starting location**: the engine still writes a `starting-location`
  placeholder even for rich seeds. Your `detail` should tell the DM where the
  opening scene begins (ideally one of your seeded locations); the Scribe renames
  the placeholder once the locale is named. No schema field for this — prompt
  around it in `detail`.
- **Scope is small and manual.** This is meant for a few dozen conversions, done
  with care, not a batch pipeline. Spend the effort on the `detail` projection —
  that's the part only judgement can do.
