/**
 * Deterministic, seeded generator of LEGAL DM-formatting documents.
 *
 * Each seed produces one well-formed document over the canonical vocabulary —
 * nested b/i/u/code/color spans, sub/sup, quotes, hard `<br>` breaks, centered
 * and right-aligned blocks, and a sprinkling of wide glyphs (CJK/emoji/accents)
 * and overlong unbreakable tokens to stress the width-correct layout. The harness
 * runs the pipeline over thousands of these at every width and asserts the
 * invariants; a failure prints its seed so it can be replayed exactly.
 *
 * No external dependency and no Math.random — fully reproducible by seed.
 */

/** mulberry32 — a small, fast, well-distributed seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "the", "ancient", "door", "whispers", "cold", "iron", "vault", "signal", "hums",
  "north", "relic", "gate", "dust", "ember", "hollow", "quiet", "star", "frost",
  "oath", "mire", "lantern", "shard", "echo", "veil", "tide", "rust", "glass",
];
const WIDE = ["你好", "世界", "日本語", "café", "naïve", "🗡️", "🔥", "🌌", "—", "résumé"];
const COLORS = ["#ff0000", "#20b2aa", "#44cc44", "#cc8844", "#009de5", "#abc", "#1a2b3c", "#e13d73"];
const STYLE = ["b", "i", "u", "code"];

type Rng = () => number;
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

function word(rng: Rng): string {
  const r = rng();
  if (r < 0.08) return pick(rng, WIDE);
  if (r < 0.12) {
    // overlong unbreakable token (no spaces) — stresses hard-break + width
    let s = "";
    const n = 4 + Math.floor(rng() * 5);
    for (let k = 0; k < n; k++) s += pick(rng, WORDS);
    return s;
  }
  return pick(rng, WORDS);
}

/** One well-formed inline run (balanced tags), bounded by `depth`. */
function genInline(rng: Rng, depth: number): string {
  const n = 2 + Math.floor(rng() * 5);
  const parts: string[] = [];
  for (let k = 0; k < n; k++) {
    const r = rng();
    if (depth > 0 && r < 0.24) {
      const tag = pick(rng, STYLE);
      parts.push(`<${tag}>${genInline(rng, depth - 1)}</${tag}>`);
    } else if (depth > 0 && r < 0.34) {
      parts.push(`<color=${pick(rng, COLORS)}>${genInline(rng, depth - 1)}</color>`);
    } else if (r < 0.40) {
      const t = rng() < 0.5 ? "sub" : "sup";
      parts.push(`H<${t}>${2 + Math.floor(rng() * 8)}</${t}>`);
    } else if (r < 0.46) {
      parts.push(`"${word(rng)} ${word(rng)}"`);
    } else {
      parts.push(word(rng));
    }
  }
  return parts.join(" ");
}

/** Produce one legal document (raw DM text) for `seed`. */
export function generateDoc(seed: number): string {
  const rng = mulberry32(seed >>> 0);
  const r = rng();

  if (r < 0.25) {
    // Aligned block, possibly multi-line via <br> (the diegetic-sign shape).
    const align = rng() < 0.5 ? "center" : "right";
    const rows = 1 + Math.floor(rng() * 3);
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) lines.push(genInline(rng, 2));
    return `<${align}>${lines.join("<br>")}</${align}>`;
  }

  // 1–3 prose paragraphs (\n\n separated), some with an in-paragraph <br>.
  const paras = 1 + Math.floor(rng() * 3);
  const out: string[] = [];
  for (let p = 0; p < paras; p++) {
    let para = genInline(rng, 3);
    if (rng() < 0.3) para += `<br>${genInline(rng, 2)}`;
    out.push(para);
  }
  return out.join("\n\n");
}
