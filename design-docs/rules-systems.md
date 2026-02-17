# Rules Systems Reference

This document catalogs freely available tabletop RPG systems that tui-rpg can use as bundled rule sets. The selection criterion is **"free to fetch at runtime"**: the full system rules must be downloadable from an official, stable URL at no cost, with no login gate. This sidesteps bundling-license concerns entirely — we fetch, parse, and cache the document at game-initialization time rather than shipping copyrighted text inside the application.

For each system, note whether the license also permits *redistribution* of the parsed/cached data (relevant if we ever ship pre-built rule packs).


---

## Systems

### 1. FATE Core & FATE Accelerated

| Field | Value |
|---|---|
| License | CC BY 3.0 (Creative Commons Attribution) + OGL (either may be used) |
| Complexity | Medium (Core) / Light (Accelerated) |
| Genre flexibility | Universal |
| Fetchable SRD | Yes — [fate-srd.com](https://fate-srd.com/); source also on [GitHub](https://github.com/fate-srd/fate-srd-content) in Markdown/HTML/Docx |
| Redistribution | Yes, with attribution to Evil Hat Productions |

**Core mechanic.** Roll 4 Fudge dice (d3 mapped to -1/0/+1). Add a skill rating. Compare to a difficulty number. Margin of success = "shifts." The key innovation is the *Aspect* system: narrative descriptors on characters and scenes that can be *invoked* for +2 or a reroll (costs a Fate point) or *compelled* by the GM to create complications (earns a Fate point). Fate Accelerated replaces skills with six *Approaches* (Careful, Clever, Flashy, Forceful, Quick, Sneaky).

**Notes.** The CC-BY license is non-viral: derivative works need not be open. Attribution bloc is a copy-paste from the top of each SRD. The Fate logo requires a separate written permission from Evil Hat. Multiple SRDs exist: Core, Accelerated, Condensed, System Toolkit, Adversary Toolkit — all fetchable from fate-srd.com.

**Freeform suitability.** High. The Aspect economy is essentially structured freeform; a "no mechanics" mode can simply skip invocations and treat Aspects as pure narrative description. The DM can run Fate Accelerated with minimal dice intervention.

---

### 2. Risus: The Anything RPG

| Field | Value |
|---|---|
| License | Custom "Risus Community License" — free to distribute unchanged, must be free of charge, attribution to S. John Ross required, no commercial use of the document itself |
| Complexity | Ultra-light |
| Genre flexibility | Universal |
| Fetchable SRD | Yes — [risusiverse.com](https://www.risusiverse.com/) and [Cumberland Games](http://risus.cumberlandgames.com/); also [Internet Archive](https://archive.org/details/RisusTheAnythingRPG) |
| Redistribution | Redistribution of the unmodified PDF is permitted; the text is **not** under CC or OGL, so extracting and re-presenting rule text requires care |

**Core mechanic.** Characters are defined entirely by *Clichés* (e.g., "Dashing Pirate 4", "Nervous Accountant 2"). Each Cliché has a die pool equal to its rating. Roll the pool, sum the dice, compare to opponent's roll. Losing dice from the pool is how damage works. The entire rulebook is ~6 pages.

**Notes.** Risus does not use Creative Commons or OGL. The license permits free hosting and redistribution of the complete, unmodified archive, but not commercial inclusion or re-packaging. For runtime fetching, direct the user's browser or a fetch call to the official URL rather than caching extracted text. Because the whole game is 6 pages, the DM agent can hold it in context verbatim.

**Freeform suitability.** Excellent. Clichés are inherently narrative; the DM can run nearly the entire game through description and only reach for dice at moments of dramatic tension.

---

### 3. Fudge

| Field | Value |
|---|---|
| License | OGL (since April 2005; original pre-2005 "Fudge Legal Notice" also permissive for non-commercial use) |
| Complexity | Light–Medium (modular; can be stripped to ultra-light) |
| Genre flexibility | Universal |
| Fetchable SRD | Yes — [fudgerpg.com](https://www.fudgerpg.com/) and [Accessible Games](https://www.accessiblegames.biz/fudge/) |
| Redistribution | Yes under OGL |

**Core mechanic.** Traits rated on a seven-point adjective ladder: Terrible / Poor / Mediocre / Fair / Good / Great / Superb. Roll 4dF (same Fudge dice as Fate — d3 mapped to -1/0/+1). Add trait level. Result is an adjective on the same ladder. FATE is a direct descendant of Fudge.

**Notes.** Fudge is the ancestor of Fate. It is more modular and toolkit-y, with less built-in narrative economy. OGL license means product identity must be separated from open content in any derivative work. Fudge predates Fate's Aspect system, so it is "purer" as a dice-adjective engine if we want something lower-ceremony.

**Freeform suitability.** High. The adjective ladder is extremely natural to narrate without surfacing numbers.

---

### 4. Open D6 / Mini Six

| Field | Value |
|---|---|
| License | OGL |
| Complexity | Light (Mini Six) / Medium (full OpenD6) |
| Genre flexibility | Universal (three genre variants: Fantasy, Adventure, Space) |
| Fetchable SRD | Yes — [Minimal OpenD6 SRD on GitHub](https://github.com/tkurtbond/Minimal-OpenD6); full PDFs at [ogc.rpglibrary.org](https://ogc.rpglibrary.org/index.php?title=OpenD6) |
| Redistribution | Yes under OGL |

**Core mechanic.** Build a dice pool from an attribute + skill rating, expressed in number of d6s (e.g., "Agility 3D+2"). Roll the pool, sum all dice, compare to a difficulty number. One die in the pool is the Wild Die (usually a different color): on a 6 it explodes (roll again and add), on a 1 it causes a complication. Mini Six is a slimmed-down single-booklet version of the West End Games D6 System that powered original *Star Wars* RPG.

**Notes.** The D6 System is beloved for its fast, intuitive feel. Mini Six strips it to essentials. Full OpenD6 genre books (D6 Fantasy, D6 Adventure, D6 Space) are all OGL and free to download.

**Freeform suitability.** Medium. Dice pools are tactile and fun but not trivially hidden. The Wild Die mechanic adds color to narration but requires the player to understand the concept.

---

### 5. 24XX (by Jason Tocci)

| Field | Value |
|---|---|
| License | CC BY 4.0 (Creative Commons Attribution) |
| Complexity | Ultra-light |
| Genre flexibility | Universal SRD; individual 24XX games are genre-specific but the SRD is genre-agnostic |
| Fetchable SRD | Yes — [jasontocci.itch.io/24xx](https://jasontocci.itch.io/24xx) (free download, pay-what-you-want) |
| Redistribution | Yes, with attribution to Jason Tocci |

**Core mechanic.** When an action is risky, roll a single die. The die size depends on relevant assets/skills: d4 (no relevant skill), d6 (some skill), d8 (strong skill), d10 (exceptional skill), d12 (near-perfect). On a 1–2: things go wrong. On a 3–4: success with a cost. On a 5+: clean success. No modifiers, no math. The system fits on one side of a business card.

**Notes.** The entire 24XX SRD is a two-page document. Designed explicitly as a framework for others to build minimal games on top of. The 24XX jam on itch.io has produced hundreds of derivatives. CC BY 4.0 is non-viral and permits commercial use.

**Freeform suitability.** Outstanding. The single-die, result-bracket approach is the most transparent possible "is there a consequence?" mechanic. The DM can trivially hide all mechanics and only surface the die when the outcome genuinely matters.

---

### 6. Cairn

| Field | Value |
|---|---|
| License | CC BY-SA 4.0 (Creative Commons Attribution-ShareAlike — note: ShareAlike is viral) |
| Complexity | Light |
| Genre flexibility | Genre-specific (OSR fantasy / folk horror) but system is easily reskinned |
| Fetchable SRD | Yes — [cairnrpg.com](https://cairnrpg.com/); source on [GitHub](https://github.com/yochaigal/cairn) |
| Redistribution | Yes, but derivatives must also be CC BY-SA |

**Core mechanic.** Derived from Into the Odd and Knave. No classes, no levels, no to-hit rolls. Stats are STR, DEX, WIL (3d6 each). Attacks always hit; roll damage die, subtract target's armor value, apply remainder to HP. When HP hits 0, damage goes to STR (a *Critical Damage* save: roll under STR on d20 or be incapacitated). Saves are d20-roll-under a stat. The system is brutally simple and fiction-forward.

**Notes.** The viral ShareAlike clause means any re-packaged version of Cairn's rules must also be CC BY-SA. For runtime-fetch purposes this is fine. For shipping a pre-built rule pack, the pack itself would need to be CC BY-SA. Cairn is deliberately minimal; the "dungeon crawl" and "wilderness" rules are the most actionable parts for a DM agent.

**Freeform suitability.** High. Damage-always-hits removes the most tedious mechanic in OSR play. The DM can narrate freely and only reach for dice on saves and damage.

---

### 7. D&D 5e SRD (v5.1 and v5.2)

| Field | Value |
|---|---|
| License | CC BY 4.0 (irrevocably, as of January 27, 2023 for SRD 5.1; SRD 5.2 released April 2025 also CC BY 4.0) |
| Complexity | Heavy |
| Genre flexibility | Genre-specific (high fantasy), but the rules chassis is widely understood |
| Fetchable SRD | Yes — [dndbeyond.com/srd](https://www.dndbeyond.com/srd) |
| Redistribution | Yes, with attribution to Wizards of the Coast |

**Core mechanic.** d20 + ability modifier + proficiency bonus vs. Difficulty Class (DC). Advantage/Disadvantage: roll 2d20, take higher or lower. Six core stats. Hit Points as a buffer. Spell slots as a resource. The SRD covers the open content of the game (many classes, spells, monsters) but excludes some classes (Artificer) and much setting material.

**Notes.** The OGL controversy of January 2023 ended with WotC releasing SRD 5.1 under CC BY 4.0 irrevocably — the license cannot be revoked. SRD 5.2 (April 2025) brings the revised 2024 ruleset under the same CC BY 4.0 terms. Both SRDs are freely fetchable. 5e is the most recognized RPG system; using it means players rarely need onboarding. Its complexity is the main downside for an AI DM: the rules interaction surface is enormous.

**Freeform suitability.** Poor. 5e's appeal is mechanical depth. Hiding the mechanics defeats the purpose of using it. Best used when the player explicitly wants 5e rules.

---

### 8. Ironsworn

| Field | Value |
|---|---|
| License | CC BY 4.0 (core rules SRD); Ironsworn: Starforged Reference Guide is CC BY 4.0; full Starforged rulebook is CC BY-NC-SA 4.0 |
| Complexity | Medium |
| Genre flexibility | Genre-specific (Norse-inspired low fantasy / solo/co-op focus); Starforged is sci-fi |
| Fetchable SRD | Yes — [tomkinpress.com/collections/free-downloads](https://tomkinpress.com/collections/free-downloads); also on [itch.io](https://shawn-tomkin.itch.io/ironsworn) (free) |
| Redistribution | Yes for SRD portions (CC BY 4.0); NC-SA applies to full Starforged rulebook |

**Core mechanic.** Oracle-driven solo/co-op play. Roll 2d10 (challenge dice) vs. 1d6 + stat (action die). Strong hit: both challenge dice beaten. Weak hit: one beaten. Miss: neither beaten. Vows are the central structure — swear an oath, undertake a journey, achieve milestones. The oracle tables (random prompts) are the generative engine. Highly compatible with AI DM narration.

**Notes.** Ironsworn is designed for GM-less play, which makes it philosophically aligned with an AI-DM setup. The content data (moves, oracles) is also available as machine-readable JSON via the [dataforged](https://github.com/rsek/dataforged) project, which is ideal for tool-call integration.

**Freeform suitability.** High. The oracle system pairs naturally with an AI that can interpret prompt results narratively. Vow/journey/combat moves are fiction-first.

---

### 9. PbtA Frameworks

Powered by the Apocalypse is a design philosophy, not a single game. Licensing varies by game; the framework itself has no single open license.

| Game | License | Fetchable | Notes |
|---|---|---|---|
| **Apocalypse World** (Baker) | No open license; an SRD was being drafted as of 2023 | No | The originator; not openly licensed |
| **Ironsworn** | CC BY 4.0 (SRD) | Yes | See above; PbtA-adjacent (move-based) |
| **Simple World** (Avery Mcdaldno) | Free PDF at [buriedwithoutceremony.com](https://buriedwithoutceremony.com/simple-world) — no explicit CC license stated | Fetchable but license unclear | A generic PbtA toolkit; worth monitoring for license clarification |
| **Breathless** (Fari RPGs) | CC BY 4.0 | Yes — [farirpgs.itch.io/breathless-srd](https://farirpgs.itch.io/breathless-srd) | Survival-horror flavor but system is generic; 250+ derivative games |
| **Charge RPG** (Fari RPGs) | CC BY 4.0 | Yes — [charge.farirpgs.com](https://charge.farirpgs.com/) / [farirpgs.itch.io/charge-srd](https://farirpgs.itch.io/charge-srd) | Generic action RPG SRD; clean modern design |

**PbtA core mechanic (shared).** When a character does something risky, a *move* triggers. Roll 2d6 + stat modifier. 10+: strong success. 7–9: success with a complication or cost. 6-: miss (the GM makes a move). Characters have a sheet of available *moves* (named fictional actions with mechanical triggers). The GM never rolls; instead GM moves are reactive narrative consequences.

**Freeform suitability.** High. The "miss = GM makes a move" structure means the AI DM is always in control of consequences. Moves can be surfaced to the player or handled invisibly.

---

### 10. Other Notable Systems

#### Charge RPG / Breathless / Fari Ecosystem

Already covered in the PbtA table above. Fari RPGs has published numerous SRDs all under CC BY 4.0 — see [farirpgs.com](https://farirpgs.com/) for the full catalog. Worth checking at initialization time for any new additions.

#### Knave (Ben Milton / Questing Beast)

Knave and Knave 2nd Edition are CC BY licensed, but the itch.io download has a $2.99 minimum — not freely fetchable at runtime. Excluded from the primary list on that basis, though it is legally redistribution-friendly if ever pre-bundled.

---

## License Comparison Quick Reference

| System | License | Non-viral? | Commercial use? | Runtime-fetchable (free)? |
|---|---|---|---|---|
| FATE Core / FAE | CC BY 3.0 | Yes | Yes | Yes |
| Risus | Custom (free, attribution) | N/A | No (document itself) | Yes |
| Fudge | OGL | Yes (OGL terms) | Yes | Yes |
| Open D6 / Mini Six | OGL | Yes (OGL terms) | Yes | Yes |
| 24XX | CC BY 4.0 | Yes | Yes | Yes |
| Cairn | CC BY-SA 4.0 | No (ShareAlike) | Yes | Yes |
| D&D 5e SRD 5.1/5.2 | CC BY 4.0 | Yes | Yes | Yes |
| Ironsworn SRD | CC BY 4.0 | Yes | Yes | Yes |
| Breathless SRD | CC BY 4.0 | Yes | Yes | Yes |
| Charge SRD | CC BY 4.0 | Yes | Yes | Yes |
| Simple World | Unclear | Unknown | Unknown | Fetchable (unclear) |

---

## Recommendations for Freeform / Hidden-Mechanics Mode

The player who doesn't want to engage with mechanics at all needs a system where:

1. The resolution mechanic is so simple the DM can call it silently.
2. The system has no mandatory player-facing procedures (no spell slots to track, no action economy to negotiate).
3. The character sheet, if any, is a narrative artifact rather than a mechanical one.

### Classic Text Adventure Mode (built-in, no external resources)

The lightest possible option: no stats, no dice, no character sheet beyond an inventory list. The conventions are universally understood from interactive fiction — examine things, pick up items, use item on problem, move in cardinal directions. The DM tracks inventory and location state using the engine's existing entity filesystem and map system. No rules to fetch, no parsing step, nothing to inject into the system prompt beyond a short mode description.

This is ideal when the player wants pure narrative exploration with item puzzles and environmental storytelling. The DM can always silently introduce light randomization (a hidden 24XX roll for risky actions) if the situation calls for it, but it's not required.

### 24XX (lightest mechanical option)

One die, one result bracket, no math. The DM knows what die to roll based on how the character was described at session start. The player need never see a number. The entire ruleset fits in the DM's system prompt with room to spare.

### Risus

Clichés are intrinsically character-voice; "Dashing Pirate 4" is interesting to a player even without understanding the dice. The DM can roll the pool silently. Only six pages of rules to internalize.

### FATE Accelerated

The Approach system (Careful, Clever, Flashy, Forceful, Quick, Sneaky) maps directly onto natural language descriptions of player intent. The DM can select the Approach and roll without the player ever choosing one explicitly. Fate points can be tracked silently and only mentioned when dramatically relevant.

### Not suitable for hidden-mechanics mode
D&D 5e (too much mandatory player bookkeeping), Open D6 (dice pools require player participation to feel right), Cairn (works well hidden, but the Save/Critical Damage loop is best when players understand stakes).

---

## Implementation Notes

- **Fetching strategy.** At game initialization, if a supported system is selected, the engine fetches the canonical SRD URL, caches it to the campaign directory as `rules-cache/<system>.md` (or `.html`/`.pdf`), and passes it to a Tier 2 (Haiku) parsing subagent that extracts structured rule data into `rules-cache/<system>.json`.
- **Parsing subagent output.** The JSON should capture: core resolution procedure, stat/attribute list, character creation steps, and any named subsystems (combat, magic, etc.) as discrete objects. The DM loads only the relevant sections into context on demand.
- **For 24XX and Risus:** The rules are short enough that the full text can be injected directly into the DM system prompt as a rules appendix, bypassing the need for a structured JSON layer entirely.
- **Ironsworn special case.** The [dataforged](https://github.com/rsek/dataforged) repository provides moves and oracles as ready-made JSON. Fetch from the GitHub raw URL at init time and skip the parsing subagent for those elements.
- **Unknown/custom systems.** If the user selects a system not on this list, the agent asks for a source document (PDF or URL), runs the Tier 2 parsing subagent, and attempts to generate a rules JSON. This is the "user-supplied materials" path described in [overview.md](overview.md).

---

## Sources

- [FATE SRD official licensing](https://fate-srd.com/official-licensing-fate)
- [faterpg.com CC-BY licensing page](https://www.faterpg.com/licensing/licensing-fate-cc-by/)
- [fate-srd-content GitHub repo](https://github.com/fate-srd/fate-srd-content)
- [Risusiverse (official Risus home)](https://www.risusiverse.com/)
- [Risus on Internet Archive](https://archive.org/details/RisusTheAnythingRPG)
- [Fudge OGL requirements](https://www.fudgerpg.com/about/legalities/ogl-requirements.html)
- [Minimal OpenD6 SRD (GitHub)](https://github.com/tkurtbond/Minimal-OpenD6)
- [OpenD6 OGC Library](https://ogc.rpglibrary.org/index.php?title=OpenD6)
- [24XX on itch.io](https://jasontocci.itch.io/24xx)
- [Cairn GitHub](https://github.com/yochaigal/cairn)
- [cairnrpg.com](https://cairnrpg.com/)
- [D&D SRD 5.1/5.2 on D&D Beyond](https://www.dndbeyond.com/srd)
- [Screen Rant SRD 5.2 CC explainer](https://screenrant.com/dnd-2024-srd-52-creative-commons-license-explainer/)
- [Ironsworn licensing page](https://tomkinpress.com/pages/licensing)
- [dataforged GitHub](https://github.com/rsek/dataforged)
- [Breathless SRD on itch.io](https://farirpgs.itch.io/breathless-srd)
- [Charge RPG SRD](https://charge.farirpgs.com/)
- [Fari RPGs](https://farirpgs.com/)
- [Simple World PDF](https://buriedwithoutceremony.com/simple-world)
- [PbtA Wikipedia](https://en.wikipedia.org/wiki/Powered_by_the_Apocalypse)
- [Bell of Lost Souls — Apocalypse World SRD announcement](https://www.belloflostsouls.net/2023/01/new-srds-and-licenses-for-apocalypse-world-and-year-zero-engine.html)
