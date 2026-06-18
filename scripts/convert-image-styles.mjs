// One-shot/repeatable converter: Image.md (monolithic catalog) -> per-style
// .mvstyle files in OKF layout (YAML frontmatter + markdown body).
//
// The style line is a VALIDATED image prompt — it is transcribed VERBATIM from
// Image.md, never paraphrased. Direction and Notes are likewise verbatim. The
// only authored fields are `description` and `tags`, supplied by
// scripts/image-style-meta.json (keyed by tag); a style missing from that map
// is emitted with `description: TODO` / `tags: []` so the file shape is stable.
//
// Run: node scripts/convert-image-styles.mjs
//
// NOTE: this builds the curation DATA MODEL only. Runtime still reads Image.md;
// integration (codegen vs native loader) is a separate, deferred step.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPT_DIR);
const IMAGE_MD = join(ROOT, "packages/engine/src/prompts/include/Image.md");
const OUT_DIR = join(ROOT, "packages/engine/src/prompts/include/Image");
const EXAMPLE_DIR = join(ROOT, "packages/engine/src/prompts/include/ImageStyleExample");
const META_PATH = join(SCRIPT_DIR, "image-style-meta.json");

const raw = readFileSync(IMAGE_MD, "utf-8").replace(/\r\n/g, "\n");

// Top-level <Tag>...</Tag> blocks (open tag at column 0, matched close).
const BLOCK_RE = /^<([A-Za-z][A-Za-z0-9]*)>\n([\s\S]*?)\n<\/\1>/gm;
const blocks = [];
let m;
while ((m = BLOCK_RE.exec(raw)) !== null) {
  blocks.push({ tag: m[1], body: m[2] });
}
const tagSet = new Set(blocks.map((b) => b.tag));

const meta = existsSync(META_PATH) ? JSON.parse(readFileSync(META_PATH, "utf-8")) : {};

// In-catalog [[Style]] wiki-links -> OKF relative links. Memory/doc refs (which
// carry underscores, so they never match this class) are left verbatim.
function linkify(text) {
  return text.replace(/\[\[([A-Za-z][A-Za-z0-9]*)\]\]/g, (full, name) =>
    tagSet.has(name) ? `[${name}](./${name}.mvstyle)` : full,
  );
}

function parseBody(body) {
  const lines = body.split("\n");
  const styleIdx = lines.findIndex((l) => {
    const t = l.trim();
    return t.length > 2 && t.startsWith("`") && t.endsWith("`");
  });
  if (styleIdx === -1) throw new Error("no style line found");
  const direction = lines.slice(0, styleIdx).join("\n").trim();
  const styleLine = lines[styleIdx].trim();
  const after = lines.slice(styleIdx + 1).join("\n").trim();
  const notes = after.replace(/^%%\s?/, "").trim();
  return { direction, styleLine, notes };
}

function yamlStr(s) {
  // Always double-quote scalars; escape backslashes and quotes.
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function frontmatter(tag, m, description, tags) {
  const title = m.title ?? tag;
  // rating: A (showcase) .. E (probation); "?" = ungraded (user's call).
  const rating = m.rating ?? "?";
  const tagList = tags.length ? `[${tags.join(", ")}]` : "[]";
  return [
    "---",
    "type: visual-style",
    `title: ${yamlStr(title)}`,
    `rating: ${yamlStr(rating)}`,
    `description: ${yamlStr(description)}`,
    `tags: ${tagList}`,
    "made-for-model: gpt-image-2",
    "---",
  ].join("\n");
}

mkdirSync(OUT_DIR, { recursive: true });

let todoCount = 0;
let ungraded = 0;
const indexRows = [];
for (const { tag, body } of blocks) {
  const { direction, styleLine, notes } = parseBody(body);
  const m = meta[tag] ?? {};
  const description = m.description ?? "TODO";
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const rating = m.rating ?? "?";
  if (description === "TODO" || tags.length === 0) todoCount++;
  if (rating === "?") ungraded++;

  const hasExample = existsSync(join(EXAMPLE_DIR, `${tag}.example.png`));
  const sections = [
    frontmatter(tag, m, description, tags),
    "",
    "# Direction",
    "",
    direction,
    "",
    "# Style",
    "",
    styleLine,
    "",
    "# Notes",
    "",
    linkify(notes),
  ];
  if (hasExample) {
    sections.push("", "# Example", "", `![${tag}](../ImageStyleExample/${tag}.example.png)`);
  }
  const out = sections.join("\n") + "\n";
  writeFileSync(join(OUT_DIR, `${tag}.mvstyle`), out, "utf-8");

  indexRows.push(
    `| [${tag}](./${tag}.mvstyle) | ${rating} | ${description.replace(/\|/g, "\\|")} | ${tags.join(", ")} |`,
  );
}

// OKF directory listing — the agent-facing menu of the whole catalog.
const indexBody = [
  "---",
  "type: index",
  'title: "Visual style catalog"',
  `description: "${blocks.length} gpt-image-2 visual styles for the Machine Violet DM's generate_image tool. One .mvstyle per style; the curation data model behind campaign<->style pairing."`,
  "---",
  "",
  "# Visual styles",
  "",
  "One row per style. `tags` are the shared match-vocabulary a campaign's visual",
  "intent is resolved against (see [TAGS.md](./TAGS.md)).",
  "",
  "| Style | Rating | Description | Tags |",
  "| --- | --- | --- | --- |",
  ...indexRows,
  "",
].join("\n");
writeFileSync(join(OUT_DIR, "index.md"), indexBody, "utf-8");

console.log(`wrote ${blocks.length} .mvstyle files + index.md to ${OUT_DIR}`);
console.log(`styles still needing description/tags: ${todoCount}`);
console.log(`styles still ungraded (rating "?"): ${ungraded}`);
const orphanExamples = readdirSync(EXAMPLE_DIR)
  .filter((f) => f.endsWith(".example.png"))
  .map((f) => f.replace(/\.example\.png$/, ""))
  .filter((t) => !tagSet.has(t));
if (orphanExamples.length) console.log(`example PNGs with no style: ${orphanExamples.join(", ")}`);
