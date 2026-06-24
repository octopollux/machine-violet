# How to swap the player character

This is a procedure, not an action. It explains how to hand player control from
the current PC to a different character — either an existing one already in the
story (an NPC, an ally) or a brand-new character. Follow every step: a PC swap
touches several independent pieces of state, and skipping one leaves the game
half-swapped (the classic failure is the roster reverting to the old PC on the
next load).

## The model

A "PC" is just a roster slot in `config.json` → `players[]` whose `character`
field names a character. The active slot is chosen by `activePlayerIndex`. The
character's *sheet* (`characters/<slug>.md`), the *party* (`characters/party.md`),
the top-frame *resources*, the *modeline*, and the *theme color* all key off
that character's name. A swap means pointing the slot at a new character **and**
bringing all of those satellites along.

`swap_pc` is the only tool that edits the roster, and it is the only step that
persists `config.json`. Everything else is ordinary sheet/UI editing.

## Steps

1. **Confirm the intent.** Who is retiring, and who takes over? Is the incoming
   character brand-new, or already an entity in the campaign? If the player is
   present, make sure this is what they want — a swap is a big narrative move.

2. **Make sure the incoming character has a PC sheet.**
   - *Existing character* (e.g. an NPC being promoted): `entity` with
     `op: "update"`, `type: "character"`, `id: "<name>"`, and a `frontMatter`
     patch setting `Type: PC`, `Player: <player name>`, `Display Resources`
     (the keys to show in the top frame, e.g. `HP, Memory`), and a
     `Theme Color`. Fill out stats/skills/abilities in the body if the sheet was
     a thin NPC stub. Add a `changelogEntry` noting the promotion.
   - *Brand-new character*: `entity` with `op: "create"`, `type: "character"`,
     and a full sheet (same PC frontMatter as above). If the player should help
     build it, you can route the build through the normal character-creation
     flow first, then come back here.

3. **Demote the outgoing PC to a character/NPC.** `entity` `op: "update"`,
   `type: "character"`, `id: "<old PC>"`, `frontMatter` setting `Type: character`
   (and clearing `Player` by setting it to `null`). In the body, note that they
   were retired from player control and may recur at DM discretion, and update
   any relationship lines that referred to them as "the PC". Add a changelog
   entry. The outgoing character is NOT deleted — they stay in the world.

4. **Swap the roster pointer.** Call `swap_pc({ character: "<new PC>",
   replaces: "<old PC>", color: "#hex" })`. Omit `replaces` to hand off the
   currently-active slot. This reassigns the slot, sets the active PC, and
   persists `config.json` — this is the step that makes the swap survive a
   reload. (`switch_player` will NOT work here: it only passes the turn between
   characters already in the roster and rejects an unknown name.)

5. **Update the party roster.** Edit `characters/party.md` so the Members list
   links the new PC (`- [[new-slug]]`) instead of the old one. Move the old PC
   out of Members (you can mention them elsewhere as a retired character).

6. **Bring the top-frame resources across.**
   - `set_display_resources({ character: "<new PC>", resources: [...] })` — which
     keys show (e.g. `["HP", "Memory"]`).
   - `set_resource_values({ character: "<new PC>", values: { "HP": "9/9", ... } })`
     — their current values.
   The old PC's resource entries can be left or cleared; they no longer display
   once the slot points elsewhere.

7. **Set the new PC's modeline.** `update_modeline({ character: "<new PC>",
   text: "..." })` so the status line reflects who you're now playing.

8. **Re-theme to the new PC (optional but expected).** If the new PC has a
   distinct theme color, `style_scene({ key_color: "#hex" })` (or a mood
   `description`) so the UI matches.

9. **Handle combat if active.** If a fight is in progress, the initiative order
   still lists the old PC as a combatant. End or rebuild combat so turn order
   tracks the new PC; don't leave a retired PC holding initiative.

## Notes

- The character sheet's `**Type:**` field holds the role — `PC`, `NPC`, or
  `character` — and the `entity` tool accepts those values (it only blocks
  relabeling a sheet as a *different* entity category like `location`). This
  field is documentary: the functional PC roster is `config.json` → `players[]`,
  changed by `swap_pc`. Keep them consistent, but `swap_pc` is what actually
  hands off control.
- The DM's in-context PC sheet block (`pcSheets`) is loaded once at session
  start and is intentionally not refreshed mid-session. After a swap it will
  still show the old sheet until the next reload — that's expected. You can see
  the new sheet via the conversation and `entity`/`show_character_sheet`. The
  on-disk state is correct, which is what matters for the next load.
- Do the file edits (steps 2, 3, 5) and the `swap_pc` call (step 4) together in
  one pass. A swap that updates the sheets but never calls `swap_pc` looks done
  on screen but reverts to the old PC on reload; a `swap_pc` with no sheet work
  leaves a PC with no real sheet.
