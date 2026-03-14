/**
 * Campaign seeds — minimal evocative premises.
 * Genre-tagged so the setup agent can filter by player's choice.
 */
export interface CampaignSeed {
  name: string;
  premise: string;
  description?: string;
  genres: string[];
}

export const SEEDS: CampaignSeed[] = [
  // ── Existing seeds ────────────────────────────────────────────────
  {
    name: "The Shattered Crown",
    premise: "A kingdom's heir is dead. Three factions claim the throne.",
    genres: ["fantasy"],
  },
  {
    name: "Ghosts of Station Proxima",
    premise: "An abandoned space station just started broadcasting again.",
    genres: ["sci-fi"],
  },
  {
    name: "The Gilded Cage",
    premise: "You're the guest of honor at a party you can't leave.",
    genres: ["fantasy", "modern", "mystery"],
  },
  {
    name: "Hollowdeep",
    premise: "A mining town's deepest shaft broke into something old.",
    genres: ["fantasy", "horror"],
  },
  {
    name: "The Last Caravan",
    premise: "Civilization is a month's ride behind you, and gaining.",
    genres: ["fantasy", "post-apocalyptic"],
  },
  {
    name: "Red Tide",
    premise: "The fishing village's catch is rotting before it reaches shore.",
    genres: ["fantasy", "horror", "mystery"],
  },
  {
    name: "The Instrument",
    premise: "You found a weapon. It found you first.",
    genres: ["fantasy", "sci-fi", "modern"],
  },
  {
    name: "Ember Protocol",
    premise: "The colony ship's AI woke you 200 years early. It won't say why.",
    genres: ["sci-fi"],
  },
  {
    name: "The Quiet Year",
    premise: "The war ended. The hard part is what comes next.",
    genres: ["fantasy", "post-apocalyptic"],
  },
  {
    name: "Teeth of the World",
    premise: "The mountains are moving. Slowly, but they are moving.",
    genres: ["fantasy"],
  },
  {
    name: "Blackwater Bay",
    premise: "A port town where everyone's running from something.",
    genres: ["fantasy", "modern", "mystery"],
  },
  {
    name: "Signal Lost",
    premise: "Mission control went silent six hours ago.",
    genres: ["sci-fi"],
  },
  {
    name: "The Debt",
    premise: "You owe a favor to someone who just called it in.",
    genres: ["fantasy", "modern", "sci-fi"],
  },
  {
    name: "Beneath the Skin",
    premise: "People in town are acting different. Not wrong, just... different.",
    genres: ["modern", "horror", "mystery"],
  },
  {
    name: "The Cartographer's Error",
    premise: "The map shows a city where there shouldn't be one.",
    genres: ["fantasy", "sci-fi"],
  },

  // ── New seeds ─────────────────────────────────────────────────────

  // --- Fantasy staples & twists ---
  {
    name: "The Oath Eaters",
    premise: "Someone is devouring sworn oaths. Contracts unravel. Alliances dissolve overnight.",
    genres: ["fantasy"],
  },
  {
    name: "A Throne of Salt",
    premise: "The empire's heartland is turning to desert. The emperor says it's on purpose.",
    genres: ["fantasy"],
  },
  {
    name: "The Shepherds",
    premise: "The dragons aren't monsters. They're livestock. And something is picking off the herd.",
    genres: ["fantasy"],
  },
  {
    name: "Root and Ruin",
    premise: "The great tree at the center of the forest is dying. Everything else is growing faster.",
    genres: ["fantasy", "horror"],
  },
  {
    name: "The Second Labyrinth",
    premise: "The minotaur's maze was a prison. Beneath it is the thing it was built to contain.",
    genres: ["fantasy", "horror"],
  },
  {
    name: "Iron Saints",
    premise: "The church's holy warriors have stopped answering prayers. They still answer to someone.",
    genres: ["fantasy", "mystery"],
  },

  // --- Sci-fi ---
  {
    name: "Jettison",
    premise: "You're adrift in an escape pod with three strangers and air for two.",
    genres: ["sci-fi"],
  },
  {
    name: "The Copernicus Mandate",
    premise: "Humanity's first alien contact is a cease-and-desist letter.",
    genres: ["sci-fi", "comedy"],
  },
  {
    name: "Skinjob",
    premise: "You just found out you're a clone. The original wants to meet.",
    genres: ["sci-fi", "mystery"],
  },
  {
    name: "Deep Tenancy",
    premise: "The generation ship's destination was reached 40 years ago. Nobody told steerage.",
    genres: ["sci-fi"],
  },
  {
    name: "The Gravity Tax",
    premise: "A megacorp owns the local gravity well. Rent is due.",
    genres: ["sci-fi"],
  },
  {
    name: "Lighthouse",
    premise: "You maintain a beacon at the edge of known space. A ship is coming from the wrong direction.",
    genres: ["sci-fi", "horror"],
  },

  // --- Modern / contemporary ---
  {
    name: "Last Call",
    premise: "The regulars at a failing dive bar are the only witnesses to something impossible.",
    genres: ["modern", "mystery"],
  },
  {
    name: "HOA from Hell",
    premise: "The neighborhood bylaws are getting stranger. Compliance is mandatory.",
    genres: ["modern", "horror", "comedy"],
  },
  {
    name: "Graveyard Shift",
    premise: "Night security at a museum. The exhibits are not where you left them.",
    genres: ["modern", "horror"],
  },
  {
    name: "The Algorithm",
    premise: "A social media feed is predicting events before they happen. It just tagged you.",
    genres: ["modern", "mystery", "horror"],
  },
  {
    name: "Route 0",
    premise: "A highway that doesn't appear on GPS. The exits lead to towns that shouldn't exist.",
    genres: ["modern", "horror", "mystery"],
  },

  // --- Post-apocalyptic ---
  {
    name: "The Bloom",
    premise: "The apocalypse was beautiful. Flowers everywhere. They haven't stopped growing.",
    genres: ["post-apocalyptic", "horror"],
  },
  {
    name: "Library Card",
    premise: "The last library is also the last fortress. Knowledge is the only currency.",
    genres: ["post-apocalyptic"],
  },
  {
    name: "The Thaw",
    premise: "The ice is retreating. What's underneath isn't ruins. It's still running.",
    genres: ["post-apocalyptic", "sci-fi"],
  },
  {
    name: "Good Soil",
    premise: "You found a patch of land where things grow clean. Everyone else found out too.",
    genres: ["post-apocalyptic"],
  },

  // --- Horror ---
  {
    name: "Floor 14",
    premise: "The hotel has 13 floors. Your room key says 1408.",
    genres: ["horror", "modern"],
  },
  {
    name: "Heirloom",
    premise: "Your grandmother's estate includes a house, a fortune, and a locked room with your name on it.",
    genres: ["horror", "mystery"],
  },
  {
    name: "The Replacement",
    premise: "You came home to find someone living your life. They're better at it.",
    genres: ["horror", "modern", "mystery"],
  },
  {
    name: "Congregation",
    premise: "A new church appeared in town last week. Nobody can remember what was there before.",
    genres: ["horror", "mystery"],
  },

  // --- Comedy / absurdist ---
  {
    name: "Middle Management of Doom",
    premise: "The Dark Lord's quarterly performance review is today. You're his direct report.",
    genres: ["fantasy", "comedy"],
  },
  {
    name: "The Bake-Off",
    premise: "A cooking competition where the judges are gods. The secret ingredient is metaphorical.",
    genres: ["fantasy", "comedy"],
  },
  {
    name: "Customer Support",
    premise: "You're a help desk operator for a company that sells wishes. Returns are complicated.",
    genres: ["comedy", "fantasy", "modern"],
  },
  {
    name: "The Roommate",
    premise: "Your new roommate is from a dimension where rent, gravity, and Tuesdays work differently.",
    genres: ["comedy", "modern", "sci-fi"],
  },
  {
    name: "Warranty Void",
    premise: "You accidentally broke reality. Tech support says it's out of warranty.",
    genres: ["comedy", "sci-fi"],
  },

  // --- Mystery / noir ---
  {
    name: "Inkblot",
    premise: "A dead artist's final painting keeps changing. The gallery owner is next.",
    genres: ["mystery", "horror", "modern"],
  },
  {
    name: "The Hound and the Fox",
    premise: "A detective and a thief keep ending up at the same crime scenes. Neither of them did it.",
    genres: ["mystery", "modern", "fantasy"],
  },
  {
    name: "Cold Open",
    premise: "You wake up in a stranger's apartment with a note in your handwriting: 'Don't trust the police.'",
    genres: ["mystery", "modern"],
  },

  // --- Truly weird / genre-bending ---
  {
    name: "The Bureau of Forgotten Things",
    premise: "Lost socks, missing pens, abandoned dreams — they all end up here. You work intake.",
    genres: ["comedy", "fantasy", "modern"],
  },
  {
    name: "Cartomancy",
    premise: "You're a character in a card game. The players keep making bad decisions.",
    genres: ["fantasy", "comedy", "meta"],
  },
  {
    name: "Apocrypha",
    premise: "You're a minor footnote in a holy text. The footnote is wrong, and that matters.",
    genres: ["fantasy", "meta"],
  },
  {
    name: "The Interstitial",
    premise: "The space between radio stations is inhabited. You just tuned in.",
    genres: ["horror", "sci-fi", "modern"],
  },
  {
    name: "Taxidermy",
    premise: "The Natural History Museum's exhibits are alive. They remember being hunted.",
    genres: ["horror", "modern", "fantasy"],
  },
  {
    name: "Closing Time",
    premise: "The universe is a shop. It's going out of business. Everything must go.",
    genres: ["sci-fi", "comedy", "meta"],
  },
  {
    name: "The Understudies",
    premise: "The Chosen Ones all died in Act One. You're the backup cast.",
    genres: ["fantasy", "comedy"],
  },
  {
    name: "Palimpsest",
    premise: "The city rebuilds itself every night from memories. Yours are leaking in.",
    genres: ["fantasy", "horror", "sci-fi"],
  },
  {
    name: "Terms and Conditions",
    premise: "You clicked 'I Agree' on a contract with a demon. The EULA is 40,000 pages.",
    genres: ["comedy", "modern", "horror"],
  },
  {
    name: "The Docent",
    premise: "A guided tour through the afterlife. Tips are appreciated. Exits are not guaranteed.",
    genres: ["fantasy", "comedy", "horror"],
  },
  {
    name: "Mise en Place",
    premise: "A restaurant where the food is memories. Tonight's special is someone else's childhood.",
    genres: ["modern", "fantasy", "mystery"],
  },
  {
    name: "Season Finale",
    premise: "You're aware that your life has a narrative structure. The ratings are slipping.",
    genres: ["meta", "comedy", "modern"],
  },
  {
    name: "Fallow",
    premise: "Magic left the world a century ago. It's trickling back. The old rules don't apply.",
    genres: ["fantasy"],
  },
  {
    name: "Severance Package",
    premise: "You just got fired from the secret organization. The exit interview involves memory erasure.",
    genres: ["modern", "sci-fi", "mystery"],
  },
  {
    name: "Petrichor",
    premise: "It hasn't rained in the city for seven years. Tonight it smells like rain.",
    genres: ["modern", "fantasy", "mystery"],
  },
  {
    name: "Night Mail",
    premise: "A postal service that delivers between worlds. Your route just got very strange.",
    genres: ["fantasy", "sci-fi"],
  },
  {
    name: "The Tenant",
    premise: "Your body has a subletter. They leave notes.",
    genres: ["horror", "modern", "comedy"],
  },
  {
    name: "Decommissioned",
    premise: "You're a retired war golem trying to open a bakery. The old programming has opinions.",
    genres: ["fantasy", "comedy"],
  },
  {
    name: "Exit Wounds",
    premise:
      "A support group for people who survived encounters with the supernatural. Someone's lying about theirs.",
    genres: ["modern", "horror", "mystery"],
  },

  // ── Developer test seeds ────────────────────────────────────────────
  {
    name: "The Rumble Pit",
    premise: "DEVELOPER TEST CAMPAIGN. A gladiatorial arena where a champion faces one combat after another. Lightly narrate a framing device — the roaring crowd, the arena master, the gates opening — then begin combat immediately. After each combat, fully restore the player's HP, spell slots, and all resources, then introduce the next wave. Escalate difficulty. No overworld, no puzzles, no shopping. Just fights, back to back. Use resolve_turn for all mechanical resolution. Use start_combat / end_combat to bracket each encounter.",
    description: "Combat stress-test: back-to-back arena fights with full restore between rounds.",
    genres: ["fantasy", "dev"],
  },
];

/** Get seeds filtered by genre */
export function seedsForGenre(genre: string): CampaignSeed[] {
  return SEEDS.filter((s) => s.genres.includes(genre));
}

/** Get N random seeds, optionally filtered by genre */
export function randomSeeds(
  count: number,
  genre?: string,
  rng: () => number = Math.random,
): CampaignSeed[] {
  const pool = genre ? seedsForGenre(genre) : [...SEEDS];
  const result: CampaignSeed[] = [];
  while (result.length < count && pool.length > 0) {
    const idx = Math.floor(rng() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}