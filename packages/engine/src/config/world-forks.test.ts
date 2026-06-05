import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorldFile, WorldFork } from "@machine-violet/shared/types/world.js";
import { normalizeForks, selectedOption, assembleCampaignDetail } from "./world-forks.js";

// --- normalizeForks ---

describe("normalizeForks", () => {
  it("returns modern forks untouched", () => {
    const fork: WorldFork = {
      id: "genre-wrapper",
      label: "Genre wrapper",
      chooser: "agent",
      options: [
        { id: "fantasy", name: "Classic Fantasy", description: "..." },
        { id: "scifi", name: "Near-Future Sci-Fi", description: "..." },
      ],
    };
    expect(normalizeForks({ forks: [fork] })).toEqual([fork]);
  });

  it("folds legacy suboptions into player-chooser forks", () => {
    const forks = normalizeForks({
      suboptions: [
        {
          label: "Your discipline",
          choices: [
            { name: "The Translator", description: "Reads dead scripts." },
            { name: "The Cartographer", description: "Maps the old quarter." },
          ],
        },
      ],
    });
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({ id: "your-discipline", label: "Your discipline", chooser: "player" });
    expect(forks[0].options.map((o) => o.id)).toEqual(["translator", "cartographer"]);
    expect(forks[0].options[0]).toMatchObject({ name: "The Translator", description: "Reads dead scripts." });
  });

  it("keeps ids unique when a folded suboption collides with an existing fork", () => {
    const forks = normalizeForks({
      forks: [{ id: "discipline", label: "Discipline", chooser: "agent", options: [{ id: "a", name: "A", description: "" }] }],
      suboptions: [{ label: "Discipline", choices: [{ name: "A", description: "" }, { name: "B", description: "" }] }],
    });
    const ids = forks.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns an empty list for a seed with no forks", () => {
    expect(normalizeForks({})).toEqual([]);
  });
});

// --- assembleCampaignDetail ---

const FORKS: WorldFork[] = [
  {
    id: "genre-wrapper",
    label: "Genre wrapper",
    chooser: "agent",
    options: [
      { id: "fantasy", name: "Fantasy", description: "", detail: "The ruins are cyclopean stonework." },
      { id: "scifi", name: "Sci-Fi", description: "", detail: "The ruins are server farms." },
    ],
  },
  {
    id: "crucial-question",
    label: "Crucial question",
    chooser: "agent",
    options: [
      { id: "lying", name: "Records lying", description: "", detail: "The records are propaganda." },
      { id: "incomplete", name: "Records incomplete", description: "" }, // no detail
    ],
  },
];

describe("assembleCampaignDetail", () => {
  it("returns base prose when nothing is selected", () => {
    expect(assembleCampaignDetail("Base premise.", FORKS, {})).toBe("Base premise.");
  });

  it("splices in only the selected branches' detail, in fork order", () => {
    const out = assembleCampaignDetail("Base premise.", FORKS, {
      "genre-wrapper": "scifi",
      "crucial-question": "lying",
    });
    expect(out).toBe("Base premise.\n\nThe ruins are server farms.\n\nThe records are propaganda.");
  });

  it("never includes an unchosen branch's detail", () => {
    const out = assembleCampaignDetail("Base.", FORKS, { "genre-wrapper": "scifi" });
    expect(out).toContain("server farms");
    expect(out).not.toContain("cyclopean stonework");
  });

  it("ignores unknown option ids and options without detail", () => {
    const out = assembleCampaignDetail("Base.", FORKS, {
      "genre-wrapper": "nonexistent",
      "crucial-question": "incomplete",
    });
    expect(out).toBe("Base.");
  });

  it("handles an empty base", () => {
    expect(assembleCampaignDetail("", FORKS, { "genre-wrapper": "fantasy" })).toBe("The ruins are cyclopean stonework.");
  });
});

describe("selectedOption", () => {
  it("resolves the chosen option", () => {
    expect(selectedOption(FORKS[0], { "genre-wrapper": "fantasy" })?.name).toBe("Fantasy");
  });
  it("returns undefined when unselected or unknown", () => {
    expect(selectedOption(FORKS[0], {})).toBeUndefined();
    expect(selectedOption(FORKS[0], { "genre-wrapper": "???" })).toBeUndefined();
  });
});

// --- Honesty test: every load-bearing fork in a bundled seed is named ---
//
// Keeps us honest as seeds gain structured forks: any fork (or legacy
// suboption) present must carry stable, unique, non-empty identifiers — that's
// the contract the rest of the system relies on to reference and resolve them.

function bundledWorldsDir(): string {
  return join(import.meta.dirname, "../../../../worlds");
}

describe("bundled seed forks are well-formed", () => {
  const dir = bundledWorldsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".mvworld"));

  for (const file of files) {
    const world = JSON.parse(readFileSync(join(dir, file), "utf-8")) as WorldFile;
    const forks = normalizeForks(world);
    if (forks.length === 0) continue; // seeds without forks are fine

    it(`${file}: forks and options are named with unique ids`, () => {
      const forkIds = new Set<string>();
      for (const fork of forks) {
        expect(fork.id, `fork id in ${file}`).toBeTruthy();
        expect(fork.label, `fork label in ${file}`).toBeTruthy();
        expect(["player", "agent"]).toContain(fork.chooser);
        expect(forkIds.has(fork.id), `duplicate fork id "${fork.id}" in ${file}`).toBe(false);
        forkIds.add(fork.id);

        expect(fork.options.length, `fork "${fork.id}" in ${file} needs options`).toBeGreaterThanOrEqual(2);
        const optionIds = new Set<string>();
        for (const option of fork.options) {
          expect(option.id, `option id in fork "${fork.id}" of ${file}`).toBeTruthy();
          expect(option.name, `option name in fork "${fork.id}" of ${file}`).toBeTruthy();
          expect(optionIds.has(option.id), `duplicate option id "${option.id}" in fork "${fork.id}" of ${file}`).toBe(false);
          optionIds.add(option.id);
        }
      }
    });
  }
});
