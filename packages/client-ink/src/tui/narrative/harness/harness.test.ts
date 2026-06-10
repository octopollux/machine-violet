/**
 * The formatting invariant harness — the acceptance gate for the re-platform.
 *
 * Drives `checkInvariants` (the real pipeline) over three input sources at many
 * widths and asserts zero violations:
 *   1. SYNTHETIC fixtures — one minimal case per construct + every known-hard combo.
 *   2. GENERATOR — seeded legal documents (bounded by default; exhaustive under soak).
 *   3. COMMITTED CORPUS — real campaign display-logs (recreates the 294-turn baseline).
 *
 * Gating (keep the normal suite fast):
 *   - default: synthetic (all widths) + 200 generator seeds + corpus at {40,80}.
 *   - MV_FORMAT_SOAK=1: 6000 generator seeds + corpus at every width.
 *   - MV_LIVE_CORPUS=<dir>: also replay the live machine corpus under that path.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { NarrativeLine } from "@machine-violet/shared/types/tui.js";
import { appendDelta } from "../../narrative-helpers.js";
import { checkInvariants } from "./invariants.js";
import { generateDoc } from "./generator.js";

const WIDTHS = [24, 40, 52, 64, 80, 100, 120];
const SOAK = !!process.env.MV_FORMAT_SOAK;

/** Reconstruct the NarrativeLine[] the live client builds for a raw DM turn. */
function dmLines(raw: string): NarrativeLine[] {
  return appendDelta([], raw, "dm");
}

// --- 1. Synthetic fixtures: one per construct + the known-hard combinations. ---
const FIXTURES: Record<string, string> = {
  plain: "The door grinds open and cold air spills across the floor.",
  nested: "<b><color=#20b2aa>deep <i>nested <u>span</u></i></color></b> tail",
  sign: "<center><color=#cc0000>OCCUPANCY VERIFIED: 2</color><br><color=#20b2aa>TRANSIT AUTHORIZED</color></center>",
  longCenter: "<center>This is a very long centered banner that absolutely will not fit a narrow terminal</center>",
  longToken: "The path is <b>supercalifragilisticexpialidociousantidisestablishmentarianism</b> long.",
  wide: "She wrote 你好世界 on the 🗡️ blade and smiled at the café 🔥 glow.",
  subsup: "H<sub>2</sub>O and E=mc<sup>2</sup> and the 1<sup>st</sup> of <sub>qzx</sub>.",
  code: "Type <code>npm test</code> then <code>git push</code> to finish.",
  right: "<right><i>— the Cartographer</i></right>",
  multiPara: "<b>First paragraph bold and long enough to wrap a little maybe.</b>\n\nSecond paragraph plain.",
  healAcrossLines: "<i>italic opens here\nand keeps going across a single newline\nthen closes</i> done",
  danglingAcrossBlank: "<i>opens but never closes\n\nfresh paragraph must not be italic",
  orphanClose: "stray close verse</i></center> should vanish",
  dialectHtml: "<strong>loud</strong> and <em>soft</em> and <h2>Heading</h2> and <br/> break",
  dialectMarkdown: "**bold** and *italic* and `code` and [link](http://x.y) and ## Title",
  quotesMultiline: '"Beware\nthe dark\nthat waits" the wizard said quietly.',
  brInProse: "Line one of the readout<br>line two of the readout<br>line three closes it",
  everything: "<center><b>THE <color=#e13d73>VAULT</color></b><br><i>你好</i> H<sub>2</sub>O <code>id_42</code></center>",
  quote: "<quote>The inscription read <i>Here lies the last honest broker</i> and beneath it someone had scratched <color=#cc0000>LIAR</color> into the stone.</quote>",
  quoteBr: "<quote><color=#cc0000>SYSTEM ALERT</color><br>Reactor breach in sector seven<br>Evacuate the platform immediately</quote>",
  quoteWide: "<quote>她写下 你好世界 然后微笑 and the 🗡️ caught the café 🔥 light just so</quote>",
  listUnordered: "Pack list:\n- A coil of rope\n- <b>Three</b> oil torches\n- A spare lantern that absolutely will not fit a narrow pane",
  listOrdered: "1. Bread primary.\n2. Crackers forbidden.\n3. Muffins await tribunal.\n4. Bell is a menace.",
  listParen: "Steps:\n1) open the valve\n2) <i>wait</i> for the hiss\n3) close it again",
  listInline: "- <color=#20b2aa>Heura</color> handles relays\n- H<sub>2</sub>O reserves low\n- <code>id_42</code> flagged",
  emptyish: "",
  whitespace: "   ",
};

describe("formatting harness — synthetic fixtures", () => {
  for (const [name, raw] of Object.entries(FIXTURES)) {
    it(`${name} holds all invariants at every width`, () => {
      for (const width of WIDTHS) {
        const violations = checkInvariants(dmLines(raw), width);
        if (violations.length) {
          throw new Error(`[${name} @ w=${width}] ${violations.map((v) => `${v.inv}: ${v.detail}`).join(" | ")}`);
        }
      }
    });
  }
});

// With wrapping disabled (width <= 0) the WIDTH and ALIGN checks are both
// skipped — `padWidth` is 0 there, which is not a meaningful column target, so
// asserting against it would spuriously flag any aligned content.
describe("formatting harness — wrapping disabled", () => {
  it("reports no WIDTH/ALIGN violations for an aligned block at width 0", () => {
    const aligned = dmLines("<center><b>A long centered banner that would overflow any real width</b></center>");
    expect(checkInvariants(aligned, 0)).toEqual([]);
  });
});

// --- 2. Seeded generator: thousands of legal documents. ---
describe("formatting harness — generative grammar", () => {
  const seeds = SOAK ? 6000 : 200;
  it(`${seeds} seeded legal documents hold all invariants`, () => {
    const failures: string[] = [];
    const widths = SOAK ? WIDTHS : [40, 80, 120];
    for (let seed = 1; seed <= seeds; seed++) {
      const raw = generateDoc(seed);
      for (const width of widths) {
        const v = checkInvariants(dmLines(raw), width);
        if (v.length) {
          failures.push(`seed=${seed} w=${width}: ${v.map((x) => x.inv).join(",")} :: ${JSON.stringify(raw.slice(0, 100))}`);
          if (failures.length >= 20) break;
        }
      }
      if (failures.length >= 20) break;
    }
    if (failures.length) throw new Error(`generator violations:\n${failures.join("\n")}`);
  }, SOAK ? 300_000 : 30_000);
});

// --- 3. Committed real corpus (recreates the offline baseline). ---
function dmSegmentsFromDisplayLog(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const segs: string[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.some((l) => l.trim() !== "")) segs.push(cur.join("\n")); cur = []; };
  for (const ln of lines) {
    if (/^>\s*\[/.test(ln) || /^\[image:/.test(ln) || /^---\s*$/.test(ln)) { flush(); continue; }
    cur.push(ln);
  }
  flush();
  return segs;
}

function runCorpusDir(dir: string, label: string, widths: number[]): void {
  if (!existsSync(dir)) return;
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== ".git") walk(p); }
      else if (e.endsWith("display-log.md")) files.push(p);
    }
  };
  walk(dir);
  describe(`formatting harness — ${label} (${files.length} logs)`, () => {
    for (const file of files) {
      it(`${file.split(/[\\/]/).pop()} holds all invariants`, () => {
        const segs = dmSegmentsFromDisplayLog(readFileSync(file, "utf8"));
        const failures: string[] = [];
        for (const seg of segs) {
          for (const width of widths) {
            const v = checkInvariants(dmLines(seg), width);
            if (v.length) failures.push(`w=${width}: ${v.map((x) => `${x.inv}: ${x.detail}`).join(" | ")}`);
          }
          if (failures.length >= 10) break;
        }
        if (failures.length) throw new Error(`corpus violations:\n${failures.slice(0, 10).join("\n")}`);
      }, 120_000);
    }
  });
}

const COMMITTED = fileURLToPath(new URL("./corpus", import.meta.url));
runCorpusDir(COMMITTED, "committed corpus", SOAK ? WIDTHS : [40, 80]);

// --- Optional live machine corpus (off by default). ---
const live = process.env.MV_LIVE_CORPUS;
if (live) runCorpusDir(live, "live corpus", WIDTHS);
