# Name pool

`names.json` is a multicultural pool of given names and surnames that the
engine samples at session start to perturb the DM model's naming priors.
Without it, every campaign tends to grow a Clara Voss and a SABLE.

- **Source:** [smashew/NameDatabases](https://github.com/smashew/NameDatabases)
- **License:** Public domain ([Unlicense](https://unlicense.org/)) — see `LICENSE`
- **Regenerate:** `npm exec tsx -- scripts/build-names.ts`

The dataset spans dozens of languages and cultures. Entries are normalised
to title case and deduplicated case-insensitively. We don't tag by culture
or era — the goal is entropy, not localisation accuracy.
