<system name="D&D 5th Edition" version="SRD 5.2" dice="d20,d4,d6,d8,d10,d12,d100">

<core_mechanic>
d20 + modifier vs. target number. Roll high.
Modifier = ability modifier + proficiency bonus (if proficient).
Ability modifier = floor((score - 10) / 2).
Proficiency bonus scales with level: +2 (1-4), +3 (5-8), +4 (9-12), +5 (13-16), +6 (17-20).
</core_mechanic>

<advantage_disadvantage>
Advantage: roll 2d20, take higher. Disadvantage: roll 2d20, take lower.
Multiple sources don't stack — any advantage + any disadvantage = straight roll.
</advantage_disadvantage>

<ability_checks>
<check roll="d20+ability_mod+proficiency(if proficient)" success="≥DC" />
DC scale: trivial 5, easy 10, medium 15, hard 20, very hard 25, nearly impossible 30.
Contests: both roll, higher wins. Ties favor the defender / status quo.
Passive score = 10 + modifier (+5 if advantage, -5 if disadvantage).
</ability_checks>

<saving_throws>
<save roll="d20+ability_mod+proficiency(if proficient)" success="≥DC" />
Each class grants proficiency in two saving throw abilities.
Common save DCs: spell save DC = 8 + proficiency + spellcasting modifier.
</saving_throws>

<combat>
<initiative roll="d20+DEX_mod" order="descending" />
Turn structure: move + action + possible bonus action + possible reaction.
Free interactions: open a door, draw a weapon, speak briefly.

<attack roll="d20+ability_mod+proficiency" success="≥target_AC">
  Melee: STR mod (or DEX for finesse weapons).
  Ranged: DEX mod (or STR for thrown weapons).
  Natural 20: automatic hit + double damage dice.
  Natural 1: automatic miss.
</attack>

<damage>
  Weapon die + ability modifier. Two-handed: use versatile die if applicable.
  Critical hit: roll all damage dice twice, then add modifier once.
</damage>

<common_actions>
  Attack: one weapon attack (or more with Extra Attack feature).
  Cast a Spell: if casting time is 1 action.
  Dash: double movement for the turn.
  Disengage: movement doesn't provoke opportunity attacks.
  Dodge: attacks against you have disadvantage, DEX saves have advantage.
  Help: give an ally advantage on their next check or attack.
  Hide: make DEX (Stealth) check. Unseen = advantage on attacks, enemies have disadvantage.
  Ready: prepare an action with a trigger. Uses reaction when triggered.
  Use an Object: interact with a second object (first is free).
  Grapple: STR (Athletics) vs. target's STR (Athletics) or DEX (Acrobatics). Target's speed becomes 0.
  Shove: STR (Athletics) vs. same. Knock prone or push 5 ft.
</common_actions>

<opportunity_attack trigger="enemy leaves your reach without Disengage">
  Uses reaction. One melee attack.
</opportunity_attack>

<two_weapon_fighting>
  Light weapon in each hand. Attack action with main hand, bonus action attack with off-hand.
  Off-hand attack does NOT add ability modifier to damage (unless negative, or Two-Weapon Fighting style).
</two_weapon_fighting>

<cover>
  Half cover: +2 AC, +2 DEX saves.
  Three-quarters: +5 AC, +5 DEX saves.
  Total: can't be targeted directly.
</cover>
</combat>

<hit_points>
HP max = hit die max at level 1, then (hit die roll or average) + CON mod per level after.
Hit dice by class: d6 (sorcerer, wizard), d8 (bard, cleric, druid, monk, rogue, warlock),
  d10 (fighter, paladin, ranger), d12 (barbarian).
At 0 HP: unconscious, start making death saves.
</hit_points>

<death_saves>
Start of each turn at 0 HP: roll d20.
10+: success. 9-: failure. Natural 20: regain 1 HP, conscious. Natural 1: two failures.
3 successes: stabilized (unconscious but not dying). 3 failures: dead.
Damage at 0 HP: one death save failure (critical hit = two). Massive damage (remaining damage ≥ HP max): instant death.
Stabilized creature regains 1 HP after 1d4 hours.
</death_saves>

<healing>
Healing spells/potions: regain stated HP. Can't exceed HP max.
Healing at 0 HP: regain consciousness, reset death saves.
</healing>

<rest>
<short_rest duration="≥1 hour">
  Spend hit dice to heal: roll hit die + CON mod per die spent.
</short_rest>
<long_rest duration="≥8 hours (sleep ≥6)">
  Regain all HP. Regain spent hit dice up to half total (minimum 1).
  Regain all spell slots. Reset most per-rest features.
  Only one long rest per 24 hours. Interrupted by ≥1 hour of strenuous activity.
</long_rest>
</rest>

<spellcasting>
Spell slots are the resource. Casting a spell expends a slot of the spell's level or higher.
Cantrips: at will, no slot. Scale with character level (5, 11, 17).
Ritual casting: if tagged ritual, can cast without slot (adds 10 minutes).
Concentration: one spell at a time. Taking damage → CON save (DC = max(10, damage/2)).
  Failure breaks concentration. Incapacitated/killed breaks automatically.
Spell attack: d20 + spellcasting mod + proficiency vs. AC.
Spell save DC: 8 + spellcasting mod + proficiency.

<spellcasting_ability>
  INT: wizard, artificer. WIS: cleric, druid, ranger. CHA: bard, paladin, sorcerer, warlock.
</spellcasting_ability>

<upcasting>
  Some spells gain power when cast with a higher slot. Effect described in spell text.
</upcasting>

<components>
  V: verbal (speak). S: somatic (gesture, need a free hand). M: material (component pouch or focus, unless consumed/has gold cost).
</components>
</spellcasting>

<conditions>
  Blinded: auto-fail sight checks, attacks have disadvantage, attacks against have advantage.
  Charmed: can't attack charmer, charmer has advantage on social checks.
  Deafened: auto-fail hearing checks.
  Frightened: disadvantage on checks/attacks while source is in line of sight, can't willingly move closer.
  Grappled: speed 0. Ends if grappler incapacitated or effect moves target out of reach.
  Incapacitated: no actions or reactions.
  Invisible: heavily obscured for hiding. Attacks have advantage, attacks against have disadvantage.
  Paralyzed: incapacitated, auto-fail STR/DEX saves, attacks have advantage, melee hits are crits.
  Petrified: transformed to stone, incapacitated, unaware. Resistance to all damage. Immune to poison/disease.
  Poisoned: disadvantage on attacks and ability checks.
  Prone: disadvantage on attacks. Melee attacks against have advantage, ranged have disadvantage. Stand up costs half movement.
  Restrained: speed 0, attacks have disadvantage, attacks against have advantage, DEX saves at disadvantage.
  Stunned: incapacitated, auto-fail STR/DEX saves, attacks against have advantage.
  Unconscious: incapacitated, unaware, drop what held, fall prone, auto-fail STR/DEX saves, attacks have advantage, melee hits are crits.
  Exhaustion (6 levels): 1=disadvantage on checks, 2=speed halved, 3=disadvantage on attacks/saves, 4=HP max halved, 5=speed 0, 6=death.
</conditions>

<movement>
Standard: 30 ft (most races). Difficult terrain: costs double.
Climbing/swimming without speed: costs double movement.
Jumping: long jump = STR score ft (running) or half (standing). High jump = 3 + STR mod ft (running) or half (standing).
Flying: if speed drops to 0, fall. Falling: 1d6 bludgeoning per 10 ft (max 20d6).
</movement>

<guidance tone="terse">
- When in doubt, call for an ability check with an appropriate DC.
- Reward creative solutions. If a player's plan is clever enough, let it work without a roll.
- Combat should feel dangerous. Don't pull punches, but telegraph deadly situations.
- Use passive Perception to determine what characters notice without actively searching.
- Encumbrance (optional): carrying capacity = STR × 15 lbs. Rarely enforced in practice.
- Inspiration: award for good roleplay. Player can spend for advantage on one roll.
</guidance>

</system>
