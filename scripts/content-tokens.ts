/**
 * Content token report + stamper.
 *
 * Reports — and optionally stamps into the files themselves — an estimated
 * token count for MV's three prompt-content file types:
 *
 *   - `.mvworld`  (JSON) — seeds. `detail` is the DM-context cost; `setup_detail`
 *                          is setup-agent-only. Stamped as a `_tokens` object.
 *   - `.mvdm`     (JSON) — DM personalities. Stamped as a `_tokens` object.
 *   - `.mvstyle`  (OKF: YAML-ish frontmatter + markdown) — image-gen visual
 *                          styles. Only `# Direction` + `# Style` reach the
 *                          model; stamped as a scalar `tokens:` in frontmatter.
 *
 * The estimate uses OpenAI's `o200k_base` encoding (GPT-4o/5) via `js-tiktoken`:
 * local, deterministic, offline — the right tool for a hook/script. It is an
 * ESTIMATE (the DM may run on Claude or GPT; tokenizers differ by ~10-15%), but
 * it is consistent across files, so it ranks "which seed is heavy" reliably.
 *
 * Counts are computed from CONTENT ONLY (the stamp field is excluded before
 * counting), so stamping is idempotent — no count → file → count feedback loop.
 *
 * Usage:
 *   npm run tokens                 # print the report, touch nothing
 *   npm run tokens -- --write      # stamp counts into the files, then report
 *   npm run tokens -- --write --commit
 *                                  # stamp; if anything changed, commit just the
 *                                  # stamped files and exit non-zero (the pre-push
 *                                  # hook uses this — re-run the push to include it)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { getEncoding } from "js-tiktoken";
import { parseOkf } from "../packages/engine/src/prompts/okf.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const enc = getEncoding("o200k_base");
const count = (s: unknown): number => (typeof s === "string" && s ? enc.encode(s).length : 0);

/** Sum token counts of every string value in a JSON tree, skipping the stamp key. */
function sumStrings(node: unknown): number {
  if (typeof node === "string") return count(node);
  if (Array.isArray(node)) return node.reduce<number>((a, x) => a + sumStrings(x), 0);
  if (node && typeof node === "object") {
    return Object.entries(node).reduce<number>(
      (a, [k, v]) => (k === "_tokens" ? a : a + sumStrings(v)),
      0,
    );
  }
  return 0;
}

const detectEol = (raw: string): "\r\n" | "\n" => (raw.includes("\r\n") ? "\r\n" : "\n");

interface Row {
  file: string;
  primary: number; // the headline number we sort/print first
  parts: Record<string, number>;
  /** New file content if a stamp would change it, else null (already current). */
  next: string | null;
}

/**
 * Re-serialize a JSON content file with a fresh `_tokens` object, preserving EOL.
 *
 * This canonicalizes formatting to `JSON.stringify(_, null, 2)`. The repo's
 * content files are already in exactly that shape (2-space pretty-print, EOL
 * preserved here), so in practice the diff is just the appended stamp — and once
 * stamped, every file is in canonical form, making subsequent stamps stable. A
 * file hand-authored with non-canonical formatting (e.g. inline objects) would
 * be normalized on its first stamp; that's a one-time tidy, not silent churn.
 */
function stampJson(raw: string, tokens: Record<string, number>): string {
  const eol = detectEol(raw);
  const obj = JSON.parse(raw) as Record<string, unknown>;
  delete obj._tokens;
  obj._tokens = tokens; // appended last → predictable placement
  let out = JSON.stringify(obj, null, 2);
  if (eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  return out + eol;
}

/** Upsert a scalar `tokens: N` line inside an OKF file's frontmatter, preserving EOL. */
function stampStyle(raw: string, tokens: number): string {
  const eol = detectEol(raw);
  const lines = raw.split(/\r\n|\n/);
  const fence: number[] = [];
  for (let i = 0; i < lines.length && fence.length < 2; i++) {
    if (lines[i].trim() === "---") fence.push(i);
  }
  if (fence.length < 2) return raw; // no frontmatter — leave untouched
  const [open, close] = fence;
  const stamp = `tokens: ${tokens}`;
  const existing = lines.findIndex((l, i) => i > open && i < close && /^tokens:\s/.test(l));
  if (existing !== -1) lines[existing] = stamp;
  else lines.splice(close, 0, stamp); // insert as the last frontmatter key
  return lines.join(eol);
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

function collectWorlds(): Row[] {
  return walk(join(repoRoot, "worlds"), ".mvworld").map((path) => {
    const raw = readFileSync(path, "utf8");
    const w = JSON.parse(raw) as Record<string, unknown>;
    const forks = Array.isArray(w.forks)
      ? (w.forks as Array<{ options?: Array<{ detail?: string }> }>)
          .flatMap((f) => f.options ?? [])
          .reduce((a, o) => a + count(o.detail), 0)
      : 0;
    const parts = {
      detail: count(w.detail),
      setup_detail: count(w.setup_detail),
      forks,
      total: sumStrings(w),
    };
    const next = stampJson(raw, parts);
    return { file: relative(repoRoot, path), primary: parts.detail, parts, next: next === raw ? null : next };
  });
}

function collectPersonalities(): Row[] {
  return walk(join(repoRoot, "personalities"), ".mvdm").map((path) => {
    const raw = readFileSync(path, "utf8");
    const d = JSON.parse(raw) as Record<string, unknown>;
    const parts = {
      prompt_fragment: count(d.prompt_fragment),
      detail: count(d.detail),
      total: sumStrings(d),
    };
    const next = stampJson(raw, parts);
    return { file: relative(repoRoot, path), primary: parts.total, parts, next: next === raw ? null : next };
  });
}

function collectStyles(): Row[] {
  const dir = join(repoRoot, "packages/engine/src/prompts/include/Image");
  return walk(dir, ".mvstyle").map((path) => {
    const raw = readFileSync(path, "utf8");
    const { sections } = parseOkf(raw);
    // Count exactly what the engine emits — `${Direction}\n\n${Style}` (see
    // loadMvstyleDir in process-includes.ts). Counting the joined string (not the
    // two parts summed) captures the separator and any boundary-token effects.
    // Notes/Example are authoring-only and never reach the image model.
    const direction = sections.get("Direction") ?? "";
    const style = sections.get("Style") ?? "";
    const emitted = count(direction && style ? `${direction}\n\n${style}` : `${direction}${style}`);
    const next = stampStyle(raw, emitted);
    return { file: relative(repoRoot, path), primary: emitted, parts: { tokens: emitted }, next: next === raw ? null : next };
  });
}

function printGroup(title: string, cols: string[], rows: Row[]): void {
  rows.sort((a, b) => b.primary - a.primary);
  const sum = (k: string) => rows.reduce((a, r) => a + (r.parts[k] ?? 0), 0);
  const width = cols.map((c) => Math.max(c.length, 6) + 2);
  const cell = (v: string | number, i: number) => String(v).padStart(width[i]);
  const line = (vals: Array<string | number>, tail: string) => cols.map((_, i) => cell(vals[i], i)).join("") + "  " + tail;
  console.log(`\n${title}  (${rows.length} files)`);
  const head = line(cols, "file");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of rows) console.log(line(cols.map((c) => r.parts[c] ?? 0), r.file.replace(/\\/g, "/")));
  console.log("-".repeat(head.length));
  console.log(line(cols.map((c) => sum(c)), "TOTAL"));
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const write = args.has("--write");
  const commit = args.has("--commit");

  const worlds = collectWorlds();
  const personalities = collectPersonalities();
  const styles = collectStyles();
  const all = [...worlds, ...personalities, ...styles];

  if (write) {
    for (const r of all) if (r.next !== null) writeFileSync(join(repoRoot, r.file), r.next);
  }

  printGroup("worlds/ (.mvworld — detail = DM context)", ["detail", "setup_detail", "forks", "total"], worlds);
  printGroup("personalities/ (.mvdm)", ["prompt_fragment", "detail", "total"], personalities);
  printGroup("Image/ (.mvstyle — emitted Direction+Style)", ["tokens"], styles);

  const stale = all.filter((r) => r.next !== null).map((r) => r.file);
  if (!write) {
    if (stale.length) {
      console.log(`\n${stale.length} file(s) have stale/absent token stamps. Run: npm run tokens -- --write`);
    } else {
      console.log("\nAll token stamps current.");
    }
    return;
  }

  if (stale.length) console.log(`\nStamped ${stale.length} file(s).`);
  else console.log("\nAll token stamps already current — nothing written.");

  if (commit && stale.length) {
    execFileSync("git", ["add", "--", ...stale], { cwd: repoRoot });
    // autocrlf can normalize a write away; only commit if something actually staged.
    const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--", ...stale], { cwd: repoRoot })
      .toString()
      .trim();
    if (staged) {
      execFileSync("git", ["commit", "-m", "chore(content): stamp token counts", "--", ...stale], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      console.error("\nToken stamps were stale — committed them. Re-run your push to include the stamp commit.");
      process.exit(1);
    }
  }
}

main();
