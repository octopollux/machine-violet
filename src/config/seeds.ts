/**
 * Campaign seeds — minimal evocative premises.
 * Genre-tagged so the setup agent can filter by player's choice.
 */
export interface CampaignSeed {
  name: string;
  premise: string;
  genres: string[];
}

export const SEEDS: CampaignSeed[] = [
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
