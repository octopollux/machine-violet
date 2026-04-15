/**
 * Fetch and bake the multicultural name pool used to perturb the DM's
 * naming priors. Source: smashew/NameDatabases (public domain, Unlicense).
 *
 *   npm exec tsx -- scripts/build-names.ts
 *
 * Writes packages/engine/src/assets/names/names.json, regenerated from the
 * upstream `all.txt` files. Re-run only when refreshing the dataset.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCES = {
  given: "https://raw.githubusercontent.com/smashew/NameDatabases/master/NamesDatabases/first%20names/all.txt",
  family: "https://raw.githubusercontent.com/smashew/NameDatabases/master/NamesDatabases/surnames/all.txt",
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages/engine/src/assets/names/names.json");

/**
 * Keep entries that look like a single human name token: 2–20 characters,
 * letters (incl. diacritics) plus optional internal apostrophes/hyphens.
 * Drops obvious noise (numbers, all-caps acronyms, multi-word entries).
 */
const NAME_RE = /^\p{L}[\p{L}\p{M}'\-]{1,19}$/u;

function clean(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/^\uFEFF/, "").trim();
    if (!trimmed || !NAME_RE.test(trimmed)) continue;
    // Title-case so "JONES" and "jones" collapse with "Jones".
    const titled = trimmed[0].toLocaleUpperCase() + trimmed.slice(1).toLocaleLowerCase();
    const key = titled.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(titled);
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return await res.text();
}

async function main(): Promise<void> {
  const [givenRaw, familyRaw] = await Promise.all([fetchText(SOURCES.given), fetchText(SOURCES.family)]);
  const given = clean(givenRaw);
  const family = clean(familyRaw);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ given, family }) + "\n");
  console.log(`wrote ${OUT}: ${given.length} given, ${family.length} family`);
}

main().catch((e) => { console.error(e); process.exit(1); });
