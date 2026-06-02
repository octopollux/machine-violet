# How to swap the DM personality

This is a procedure, not an action. It explains how to change the DM's
personality — the narrative voice running the table — mid-campaign, either to
one of the available presets or to a custom persona you invent. It's a small
mechanical change with one big craft requirement: the voice handoff.

## The model

The DM personality is a single field, `config.dm_personality`, with a `name`, a
`prompt_fragment` (the voice/style instructions woven into your system prompt), an
optional hidden `detail` block (signature techniques, pacing rules — never shown
to the player), and an optional `description` (one-line player-facing flavor).

It is read **live at the start of every DM turn**, so unlike a character sheet
there's no reload lag: the moment you call `swap_dm_personality`, the *next* DM
narration runs under the new voice. (That next turn pays a one-time prompt-cache
recreation; cheap, and it re-caches immediately.)

`swap_dm_personality` is the only tool that edits `config.dm_personality`, and it
persists the change to `config.json`.

## Steps

1. **Decide: preset or custom?** Is the player choosing from the existing
   personas, or asking for a bespoke voice?

2. **Load the catalog.** Call `list_dm_personalities`. The in-game agent doesn't
   carry the persona list in context (only the setup agent does), so this is how
   you learn what's available — names and descriptions, plus which one is current.

3. **Let the player choose** (unless they already named one). Use `present_choices`
   with persona names as labels and descriptions as the per-choice text. Offer a
   handful that fit the campaign's tone. If the player wants something not on the
   list, you can invent one — craft a name and a 2-4 sentence `prompt_fragment` in
   the same second-person style as the presets ("You are … You narrate …").

4. **Swap.** Call `swap_dm_personality`:
   - Preset: `{ name: "The Trickster" }` — the name must match a `list_dm_personalities`
     entry; its prompt_fragment and detail come along automatically.
   - Custom: `{ name, prompt_fragment, detail?, description? }` — your invented voice.

5. **The handoff — required.** The new voice takes your *next* narration. Do not
   switch silently: that next turn must open with a deliberate, in-fiction
   transition that carries the player from the old voice into the new one — a
   visible shift in register, acknowledged in the fiction, so it reads as
   intentional rather than a glitch. Bridge first, then continue the scene fully
   in the new persona. This handoff is what lets you proceed cleanly; skipping it
   produces tonal whiplash.

## Notes

- The `detail` block is hidden tuning — it shapes how you narrate but is never
  surfaced to the player. Presets carry their own; for a custom persona, supply
  `detail` only if you want that extra steering.
- The persona `name` shows up in session recaps and the Discord presence line, so
  pick a name you're happy to see there.
- Nothing else needs touching — no character sheets, no theme, no party. This is
  purely the DM's voice. (If the new tone also calls for a visual mood change,
  that's a separate, optional `style_scene` call.)
