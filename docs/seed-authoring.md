# Authoring & Reviewing Campaign Seeds

The editorial playbook for the bundled `worlds/*.mvworld` catalog — what makes a
seed *good*, and how to run a review pass over the whole catalog. These are
practices distilled from a full pass over the catalog, not schema.

- **Schema, channels, forks, materialization** → [format-spec.md §10](format-spec.md#10-world-files-mvworld). Read it first; this doc assumes it.
- **Turning a *played campaign* into a seed** (importing its NPCs/locations) → the `build-mvworld` skill ([`.claude/skills/build-mvworld/SKILL.md`](../.claude/skills/build-mvworld/SKILL.md)) + the worked example [`worlds/the-salt-wedding.mvworld`](../worlds/the-salt-wedding.mvworld).
- **Setup flow / how a seed is chosen and finalized** → [game-initialization.md](game-initialization.md).

A seed is a *projection*, not a story: a standing world + a forward-looking
premise that many different campaigns can grow out of. You are not writing what
happened — you are setting up a space where things can happen.

---

## The mechanical truth that bites every time

**The setup agent never sees `world.detail`.** Via `load_world` it gets only the
`forks` (labels/options/ids), the config hints (`system`/`mood`/`difficulty`/`campaign_scope`),
and `setup_detail` (`renderWorldForAgent`, §10.4/§10.7); the seed's `summary`/`genres`
reach it separately, in its world list. The DM-only `detail` reaches it by neither
path. So any directive about *how the game opens* — the opening beat, "don't reveal the
secret in scene 1", "ground the first scene in the chosen role" — that you write
into `detail` is **invisible to the agent that composes `opening_scene`**. It
must live in `setup_detail` as a **pin** (a short "begins in…" hint) or it never
fires. This is the single most common authoring bug; check it on every seed that
cares about its opening.

---

## What makes a seed good — the design bars

Each bar below is a reason a seed gets **enriched** (most), or **disabled as a
rebuild candidate** (a loved concept that doesn't yet clear a bar), or **set
aside**. A clever premise is necessary, not sufficient.

### A seed needs a place *and* a call to action
A high-concept kernel alone gets disabled. Check both:
1. **Does it happen somewhere inhabitable?** Not an abstract / distributed /
   conceptual setting — a place the player and DM can stand in.
2. **Is there an active thing the player is driven to do from turn 1?** Not a
   passive chore (reading a document), not *only* a hidden agent-secret goal the
   player can't see.

A ticking clock or a clever conceit does not substitute for either. Seeds that
fail this get parked as rebuild candidates even when the concept is beloved
(historical fails: a 40k-page-EULA legalese comedy that "happened" only inside a
document; a geologic-timescale fantasy with no short-horizon engine a human PC
can act on).

### Location skeletons — the narrow-setting fix
The DM has a **universal narrow-setting weakness**: it forms a cramped picture of
a location and only unfolds new rooms when forced. The fix: for each
location/setting **type** a seed offers, give a **DM-facing sub-location skeleton
of ~10–15 named spaces** — brief, not high-concept ("comms room, galley, reactor
chamber, three airlocks, the empty bunk…") — plus a one-line "move through it and
name more" nudge.

- **Mechanism:** a bare `suboption` can't carry a `detail` channel, so **promote
  the location axis to a player `fork`** and put each type's skeleton in its
  option `detail` (see the recipe below). The player still sees only
  name+description; the DM gets the bones.
- **Template:** [`worlds/lighthouse.mvworld`](../worlds/lighthouse.mvworld) → the
  `the-beacon` fork (4 location types × ~14 spaces each).
- **Single-location seeds** get a base-`detail` skeleton instead of a fork.
- **Exemptions — do NOT add a skeleton:**
  - **Route / journey seeds** — when *movement* is the premise, the DM invents
    locations fine; the weakness is fixed-location-only.
  - **Deliberately short-and-memorable seeds** — a tight self-contained hook whose
    value is brevity; real estate works against it. ("Short and memorable" is a
    legitimate, valuable archetype.)
  - **One-room bottle** seeds where the smallness *is* the point.

### Mystery-box is peak MV content — lean in
Slow-reveal / withhold-the-center seeds are exactly what MV's persistent-state,
infinite-campaign, location-growth engine is built for. **Do not ration them or
dedup them against each other** (dedup is only for genuine premise-twins). Lean
in: withhold the central question, reveal in pieces (each answer opens two more),
gate the payoff behind earned play, and track discovered locations as entities so
"the world is primed to grow." The recurring authoring trap is the opposite — the
DM dumping the whole box in the opening scene; fight it with a *positive
slow-burn* brief (early game has its own content; ≤1 new edge per scene; "don't
open the box until the player could describe the world without your help") plus an
opening pin that forbids the secret from appearing in scene 1.

### Don't put a timer on an exploration seed
When a seed has an in-game clock (a countdown, a season, a temperature, a
melt-rate), the reflex is `Pacing.TimedCampaigns`. **Resist it** if the seed's
core pleasure is exploration / unhurried discovery — a deadline fights the very
thing the player came to savor. Instead, leave pacing at default (or
`EndlessCampaigns`) and **reframe the clock as a reveal-engine** (it keeps
*opening* more to explore) rather than a deadline (run out and lose). Reserve
`TimedCampaigns` for genuine pressure/race premises (escape, siege,
beat-the-collapse).

### No pre-roleplay
A seed's `detail` should state world-*facts*, never the PC's prior
knowledge/feelings/history. The story doesn't begin at the beginning; the PC
discovers their situation in play, and that discovery + agency belong to the
player. Don't write "you have always feared the lighthouse" — write what the
lighthouse *is*.

### Originality — no artist or IP imitation
MV's seeds are **original work**, and we extend other creators the courtesy we'd
want for ourselves: we don't take their material — not because we might get caught,
but because it isn't ours to take and MV is its own art. So never bake "in the
style of [a real artist]" into shipped content, and don't ship a premise that is
really a specific living (or recently-dead) creator's published work, however it's
dressed up. This is a Golden Rule — be decent, make our own thing — **not** a legal
hedge; the aim is never to borrow-without-getting-caught, it's to build something
genuinely ours. Citing a touchstone to each other is normal, welcome shorthand — a compressed
bundle of stylistic influences (mood, palette, tempo) to converge on a vibe, never
a request to reproduce anyone. The discipline lives at the **output boundary**: by
the time the influence becomes a file on disk it has been metabolized into
something genuinely your own, so no creator is actually ripped off. (This is the
*legitimate* sense of "clean-rooming" — reference in, original work out — as
opposed to the evasion reading, "disguise a rip-off well enough to get away with
it," which is exactly what we're not doing.) So a named work is fine as private
user↔Claude shorthand to get on the same page; the job is then to **make something
genuinely your own** — your own world, described by its genre and mood — before it
reaches the repo (e.g. "1970s occult noir in a rain-soaked city", arrived at on its
own terms — not a retread of any one film). If a built seed turns out to be an
unmistakable homage, rename it so MV isn't shipping someone else's title and
disable it until it can be rebuilt as something original.

### Broad appeal — the archetype, plus one fresh angle
The catalog skews to a narrow taste (high-concept, literary, modern/sci-fi); the
broad audience is the union of three overlapping crowds — **Players** (be the
hero), **Readers** (live inside a novel; romance above all), and **Shippers/AO3**
(play the trope and the ship) — and the overlaps are where MV's character-driven,
text-first engine beats combat-and-dungeon competitors. To serve them, build the
*familiar* archetype (heroic fantasy, space-opera, cozy romance, whodunit), but
deliver it cleanly **and** alive with one fresh, specific angle, so it reads as
instantly legible *and* not generic — e.g. heroic save-the-realm → the gathering
dark is *literal* (relight the realm's old lights, region by region). The danger
is blandness; the fix is one sharp angle plus the usual bars (a real place, a
clear call to action, a good opening, a crucial-question for replay depth).

### Framework, not fandom
The biggest IP-driven crowds (superhero fans, fandom shippers) are served by
shipping **generic, clean-room frameworks** that the *player* specializes at
setup — they turn `the-coffee-shop` into a Stony fic, a powered-team framework
into the Avengers, in *their* private game. We never ship the IP; they bring it.
This reaches those audiences **and** keeps the originality bar intact (above). The
craft: design a framework to be great *empty* and a great *canvas* — rich on its
own, and an easy thing for a player to pour a fandom into. `the-coffee-shop` is
the exemplar.

### Player-identity forks are optional
Players can always state their own character concept at chargen, so a seed does
**not** need a "who you are" fork for parity. Add one only when it earns its place
by carrying real DM-facing per-option `detail` (access, leverage, the angle the
city comes to them from) — not as a checkbox.

### Fantasy — take the lead
The catalog is weak on fantasy and the typical request is light on fantasy ideas.
On fantasy seeds, **drive**: bring engine-first concepts (a clear "what happens",
not just worldbuilding), propose the *game*, enrich harder. The fantasy seeds
that work are engine-first + grounded (a real company town, economic pressure,
grief) with the fantasy/horror as an *intrusion*, not seeds that are all
cosmology and no happening.

### Authoring romance & relationship seeds
The relationship lane (Readers + Shippers) is a strength to lean into, with its own craft:
- **Seed the romantic hook *explicitly*.** Romance does not emerge from a neutral world — name the love interest(s), make them genuinely desirable, and structure the pull, or the DM simply won't run it. (A fae-bargain seed has to *say* the patron is the love interest.)
- **Offer contrasting love interests where it fits.** The choice between two desirable-but-very-different options is a core romance pleasure (a stranger-spouse *and* a written-in paramour).
- **The call to action is relational**, not a quest objective — pursue the bond, navigate the obstacle, earn the slow burn. A found-family fellowship is the same engine wrapped around any genre pillar.
- **Stay maturity-neutral.** Do **not** encode a heat level in the seed (no "fade to black", no "keep it tasteful", no steaminess directives — in either direction). Enforcement lives *outside* seed content: the player's age bracket, the model's guardrails (which vary over time), and content classifiers. Build a relationship-rich framework and let the runtime + player + model govern how far a session goes; don't QA the guardrails from the seed side.

---

## The review checklist

For each seed, for each dimension: **accept the upstream default, or override?**
Nothing has to exist in the seed file — every dimension has a working default.

| # | Dimension | Default (seed silent) | How a seed overrides |
|---|---|---|---|
| 1 | **Pacing** | Setup prompt's `<!--include:Pacing-->` — the standard scope question (One-Shot / Few / Grand / Open-Ended) | A `Pacing.*` variant in `setup_detail` (table below), or a hard `campaign_scope` field (skips the question) |
| 2 | **Opening scene** | Setup agent composes a character-grounded `opening_scene` at finalize (§10.4) | A "begins in…" **pin** in `setup_detail`, **or** `<!--include:OpeningScene.DMHandled-->` to suppress it so the DM opens from the seed's own brief |
| 3 | **Summary** | The seed's `summary` (always present — the public face, seen side-by-side with other seeds in the chooser) | Rewrite to kill uniform "two-sentence movie-trailer" cheese; vary the structure so seeds read as distinct works next to each other |

**Guiding notes (not scored, but check every seed):** *no pre-roleplay* (above);
*location skeletons* (above); *place + call to action* (above).

---

## Recipes

### Promote a suboption → player fork (the workhorse move)
The most common enrichment. A bare `suboptions` choice carries only
`name`/`description` (no DM channel); to attach per-option DM-facing material
(location skeletons, faction playbooks, per-option engines) you must promote it to
a player `fork`:

```jsonc
// before — player sees the choice, DM gets nothing per-option
"suboptions": [{ "label": "The station", "choices": [{ "name": "...", "description": "..." }] }]

// after — player still sees name+description; the DM gets `detail` on selection
"forks": [{
  "id": "the-station", "label": "The station", "chooser": "player",
  "prompt": "The player picks where this happens; each option's detail is the DM's location skeleton.",
  "options": [{ "id": "...", "name": "...", "description": "...", "detail": "SKELETON: comms room, galley, ..." }]
}]
```

- **Player forks** (`chooser: "player"`) are presented; `description` is
  player-safe. **Agent forks** (`chooser: "agent"`) are rolled/chosen by the setup
  agent and kept secret (the genre wrapper, the crucial-question); `description`
  is DM-facing guidance.
- An option's `detail` splices into `campaign_detail` only when selected (§10.6).
- ⚠️ **Modern fork options take an explicit author-provided `id`** — you write it.
  (Auto-derivation — article-stripped + kebab-cased via `slugify`, "The Gilded
  Compact" → `gilded-compact` — happens only when *legacy* `suboptions` are folded
  into forks by `normalizeForks`.) When you promote a suboption that a **recorded
  golden tape** selected, write the id to match what the tape recorded (the old
  slugified form) — a mismatch is a hard fork-resolution failure (see the landmine below).

### Pacing variants (`setup_detail` includes)
All live in [`packages/engine/src/prompts/include/Pacing.md`](../packages/engine/src/prompts/include/Pacing.md). Place the include in `setup_detail`, **never `detail`** (in `detail` it would expand into the DM's context and make it re-ask the scope question on turn 1).

| Include | Offers | Use for |
|---|---|---|
| `Pacing` (default — no include needed) | One-Shot / Few / Grand / Open-Ended | length is wildly player/branch-dependent → keep the question open |
| `<!--include:Pacing.ShortCampaigns-->` | Coffee Break / One-Shot / Few | tight, self-contained arcs |
| `<!--include:Pacing.EndlessCampaigns-->` | Open-Ended / Serialized / Unstructured | living cities, anthology/episodic, serialized cases |
| `<!--include:Pacing.TimedCampaigns-->` | (skips the scope question) | a real in-game clock with teeth — escape, siege, beat-the-collapse |
| `<!--include:Pacing.Iterated-->` | (skips the scope question) | time-loop / iterated-game premises |

**Epic / multi-act pacing (when the DM tends to rush the arc).** The scope buckets don't *enforce* pacing, and the DM biases toward delivering the payoff early — collapsing a save-the-realm epic into a few scenes. For a long arc, write a DM-facing **movement ladder** in `detail` (Act I local & personal → Act II the long middle → Act III the source) with explicit anti-rush directives ("hold each until it pays off"; "when unsure it's time to escalate, it isn't") and progress framed as a *rising tally*, not a countdown. Best of all, make the pacing **structural**: an engine where the player *can't* skip ahead (relight the realm region by region — they physically can't do it all at once) enforces the acts better than any directive. See `the-gathering-dark`.

### The opening-scene spectrum (`setup_detail`)
Three points, increasing DM control of turn 1:
1. **Default** — write nothing; the setup agent composes a grounded opening. (Best
   when the seed has no scripted turn 1 and the forks give strong per-PC hooks.)
2. **Pin** — a prose "begins in…" hint in `setup_detail`; the agent honors it.
   Use this to ground the opening in the chosen role, to open *before* the hook
   lands, or to forbid the secret from surfacing in scene 1. **This is where you
   surface any opening directive that's currently stranded in `detail`.**
3. **DMHandled** — `<!--include:OpeningScene.DMHandled-->`; the agent declares no
   opening and the DM opens from the seed's own brief. Use only when `detail`
   itself scripts turn 1 (e.g. a cold-open / amnesia premise).

### NPC includes (DM-facing, place at the END of `detail`)
[`packages/engine/src/prompts/include/NPC.md`](../packages/engine/src/prompts/include/NPC.md): `Atmospheric`, `Introverted`, `AsParty` — referenced as e.g. `<!--include:NPC.Introverted-->`. Use to tune how much the world's cast crowds the player. These are density *modifiers* only; the always-on NPC craft and the not-omniscient rule live in `dm-directives.md`'s `<About_NPCs>` block, so default density needs no include.

### Visual style (`image_style`)
Every seed sets a top-level `image_style` — the stem of a `.mvstyle` variant in [`packages/engine/src/prompts/include/Image/`](../packages/engine/src/prompts/include/Image/) — which drives the chargen portrait and in-game art ([format-spec §10.8](format-spec.md#108-visual-style-image_style)). **Default a new seed to `PainterlyGame`** — a stylised painterly render that goes with essentially any genre. Leave the *specific* pick (a fitting catalog style, or a per-seed composite) to the render-and-eyeball **grade pass**, where styles are chosen by looking at renders, not guessing from seed text ([docs/visual-style-authoring.md](visual-style-authoring.md)).

### Disable / delete / rename-an-homage
- **Disable** (drop from enumeration, keep the file & concept): `git mv foo.mvworld foo.mvworld.disabled`. Use for rebuild candidates and set-asides. Fork-test counts change — expect that.
- **Delete** (truly redundant; fold the best bits into a neighbor first): `git rm`.
- **Rename-then-disable** (when a parked seed is too close to someone else's work — so MV isn't shipping their title even while it sits disabled): edit the `name` field, then `git mv` to a new `<original-slug>.mvworld.disabled`; rebuild it as original work later.

### Validate an edit
```bash
node -e "JSON.parse(require('fs').readFileSync('worlds/<slug>.mvworld','utf8'))"   # JSON sanity
npx vitest run packages/engine/src/config/world-loader.test.ts \
               packages/engine/src/config/world-forks.test.ts                       # loader + forks
# seeds with an `entities` block also:
npx vitest run packages/engine/src/agents/world-builder.test.ts
# edits to a SHARED prompt include (Pacing.md / OpeningScene.md / dm-directives.md):
npm run golden:verify
```
JSON-in-edit gotchas: in single-line `detail` strings `\n` is a literal escaped
newline; in pretty-printed `forks`/`suboptions` arrays newlines are real. Avoid
inner double-quotes in new prose (use single quotes / em-dashes).

### ⚠️ Seeds wired into the setup goldens
A few seeds are selected by the recorded `setup-corpus.golden.test.ts` scenarios
(notably **`the-shattered-crown`** → the `setup-quickstart-fantasy` golden, and
its `setup-dnd-character` sibling). Two consequences when you edit such a seed:
- **Fork option ids must match the recorded tape** (the tape selected
  `gilded-compact`, so the promoted fork's ids stay article-stripped). A mismatch
  is a *hard* fork-resolution failure, not a snapshot diff.
- **Enriching its `detail` changes the finalized `campaignDetail`**, so the golden
  snapshot drifts. That's an intended snapshot change — re-derive it (see
  [golden-tapes.md](golden-tapes.md); offline re-derive from the existing tape
  when only the snapshot moved) and review the diff.

---

## Running a full review pass

To re-run this loop when you have new concepts to fold in:

1. **Order:** walk `worlds/*.mvworld` **asciibetically**, one seed at a time. (New
   seeds you build mid-pass may sort behind you — that's fine, they're born
   compliant.)
2. **Scratch tracker:** keep a working `seed-review.md` at the repo root
   (untracked; not committed) with: a resume block, the checklist + any new
   guiding notes, a progress list, a parking lot (disabled seeds + why), a
   decisions log (one line per closed seed, with its commit hash), and a backlog.
   Update it **every turn** — it's the handoff across `/compact`.
3. **Per-seed flow:** read the seed → assess each checklist dimension (current
   state + recommend accept-default-or-override) → the user makes the creative
   call → edit → validate → commit (one commit per seed, detailed message) → log →
   next.
4. **New design bars** get appended to the checklist as the user names them, and
   the durable ones get written to memory so they survive future sessions.
5. **Re-record goldens** only when you touched a shared prompt include or a seed
   wired into a setup golden — and treat it as an *intended* snapshot change
   (review the diff), per [golden-tapes.md](golden-tapes.md).
6. **Push / PR only on explicit request.** Commit freely throughout.

The standing design bars above are the accumulated output of one such pass; add to
them as the catalog teaches you more.
