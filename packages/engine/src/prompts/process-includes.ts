import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";
import { parseOkf } from "./okf.js";

/**
 * Include preprocessor + cascading entity override.
 *
 * Two features live here because they share a vocabulary (top-level XML
 * blocks as "entities") and because the entity-override step consumes the
 * output of the include step.
 *
 * ── Includes ──
 *
 * A prompt may contain directives shaped like HTML comments:
 *
 *     <!--include:NPCS-->
 *     <!--include:NPCS.Military-->
 *
 * Each directive is replaced inline with a `<TagName>...</TagName>` block:
 *
 *   - The file lives at `prompts/include/<TagName>.md` (here, `NPCS.md`).
 *   - With a dot suffix (`NPCS.Military`), the file is parsed for top-level
 *     `<Variant>...</Variant>` sections and the named variant's body is
 *     inserted. The outer wrapping tag is always the file stem — `NPCS` —
 *     never the variant name. So `NPCS.Military` produces `<NPCS>...</NPCS>`,
 *     not `<Military>` or `<NPCS.Military>`. This is intentional: the file
 *     holds variants of the same logical entity; the include picks one.
 *   - Without a dot (`NPCS`), the file's section named the same as the file
 *     stem is the default — so `include/NPCS.md` is expected to contain an
 *     `<NPCS>` section that serves as the typical default. As a convenience,
 *     a file with no top-level XML sections at all is treated as one
 *     implicit default section: its whole body is wrapped in the stem tag.
 *
 * Must run AFTER `applyModelConditionals` (so conditionals can guard whether
 * an include happens) and BEFORE `stripComments` (since the directive is
 * itself an HTML-comment-shaped marker that comment stripping would erase).
 *
 * ── Cascading entity override ──
 *
 * Once includes are resolved, the prompt contains top-level XML blocks
 * (some written inline, some produced by includes). When the same tag
 * appears in more than one slot of an ordered layer list, the latest slot
 * wins; earlier occurrences are removed entirely and the latest slot's block
 * stays in place. `buildDMPrefix` passes FIVE slots, lowest → highest:
 * dm-identity → dm-directives → campaign_detail → personality prompt_fragment
 * → personality detail.
 *
 * This lets a DM personality redefine the `<NPCS>` block (or any other entity)
 * that the main DM prompt established, without editing the main prompt file —
 * and it lets the setup agent's appended `campaign_detail` override a seed's
 * block. Resolution is done at the buildDMPrefix layer; this module just
 * exposes the merge primitive.
 */

const VARIANT_RE = /^<([A-Za-z][\w]*)>([\s\S]*?)<\/\1>/gm;
const DIRECTIVE_RE = /<!--include:([A-Za-z][\w]*)(?:\.([A-Za-z][\w]*))?-->/g;
const TOP_LEVEL_BLOCK_RE = /^<([A-Za-z][\w]*)>([\s\S]*?)<\/\1>/gm;

export interface IncludeFile {
  /** Explicit named sections, keyed by tag name. */
  variants: Map<string, string>;
  /**
   * True when the file had no top-level XML sections. The whole body is then
   * treated as one implicit default section — see `flatBody`.
   */
  isFlat: boolean;
  /**
   * The whole body with only surrounding newlines trimmed (leading/trailing
   * blank lines), populated only when `isFlat`. Indented prose at the start
   * of a flat file is preserved verbatim.
   */
  flatBody: string;
}

export function parseIncludeFile(content: string): IncludeFile {
  const normalized = content.replace(/\r\n/g, "\n");
  const variants = new Map<string, string>();
  VARIANT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VARIANT_RE.exec(normalized)) !== null) {
    const tag = m[1];
    const body = m[2].replace(/^\n/, "").replace(/\n$/, "");
    variants.set(tag, body);
  }
  if (variants.size === 0) {
    // Strip only surrounding newlines — preserve any intentional indentation
    // at the start or end of the body.
    return { variants, isFlat: true, flatBody: normalized.replace(/^\n+/, "").replace(/\n+$/, "") };
  }
  return { variants, isFlat: false, flatBody: "" };
}

/**
 * Directory-backed include: a `<Tag>/` folder of `.mvstyle` (OKF) files, one
 * per variant. Builds the same {@link IncludeFile} shape `parseIncludeFile`
 * produces, so `processIncludes` resolves `Tag.Variant` → `<Tag>/Variant.mvstyle`
 * and dotless `Tag` → `<Tag>/<Tag>.mvstyle` unchanged. Only the DM-facing
 * `# Direction` + `# Style` sections are emitted — frontmatter, `# Notes`, and
 * `# Example` are authoring/selection metadata and never reach the DM (the
 * structured successor to `stripComments` dropping `%%`).
 */
function loadMvstyleDir(dirPath: string): IncludeFile {
  const variants = new Map<string, string>();
  for (const file of readdirSync(dirPath).sort()) {
    if (!file.endsWith(".mvstyle")) continue;
    const tag = file.slice(0, -".mvstyle".length);
    const { sections } = parseOkf(readFileSync(join(dirPath, file), "utf-8"));
    const direction = sections.get("Direction");
    const style = sections.get("Style");
    // Both DM-facing sections are required — a partial file would silently ship
    // a broken style directive, so fail fast naming the offending file.
    if (!direction || !style) {
      const missing = [!direction && "# Direction", !style && "# Style"].filter(Boolean).join(" + ");
      throw new Error(`Malformed .mvstyle (missing ${missing}): ${join(dirPath, file)}`);
    }
    variants.set(tag, `${direction}\n\n${style}`);
  }
  return { variants, isFlat: false, flatBody: "" };
}

const fileCache = new Map<string, IncludeFile>();

function loadIncludeFileFromDisk(name: string): IncludeFile {
  const cached = fileCache.get(name);
  if (cached) return cached;
  const baseDir = join(assetDir("prompts"), "include");
  const dirPath = join(baseDir, name);
  let parsed: IncludeFile;
  if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
    parsed = loadMvstyleDir(dirPath);
  } else {
    const filePath = join(baseDir, `${name}.md`);
    if (!existsSync(filePath)) {
      throw new Error(`Include file not found: prompts/include/${name}.md`);
    }
    parsed = parseIncludeFile(readFileSync(filePath, "utf-8"));
  }
  fileCache.set(name, parsed);
  return parsed;
}

export interface ProcessIncludesOptions {
  /** Test-only override; default loads from prompts/include/. */
  loader?: (name: string) => IncludeFile;
}

export function processIncludes(text: string, opts: ProcessIncludesOptions = {}): string {
  const loader = opts.loader ?? loadIncludeFileFromDisk;
  return text.replace(DIRECTIVE_RE, (_match, tag: string, variant: string | undefined) => {
    const file = loader(tag);
    let body: string;
    if (variant === undefined) {
      // Dotless form: section named same as file stem is the default. Falls
      // back to flat-file body when the file has no sections at all.
      const def = file.variants.get(tag);
      if (def !== undefined) {
        body = def;
      } else if (file.isFlat) {
        body = file.flatBody;
      } else {
        const choices = [...file.variants.keys()].join(", ") || "<none>";
        throw new Error(
          `Include '${tag}' has no default <${tag}> section in prompts/include/${tag}.md (available: ${choices}); use ${tag}.<Variant>.`,
        );
      }
    } else {
      if (file.isFlat) {
        throw new Error(
          `Include '${tag}' is a flat file (no variants); use ${tag} without '.${variant}'.`,
        );
      }
      const v = file.variants.get(variant);
      if (v === undefined) {
        const choices = [...file.variants.keys()].join(", ") || "<none>";
        throw new Error(
          `Include variant '${tag}.${variant}' not found (available: ${choices}).`,
        );
      }
      body = v;
    }
    return `<${tag}>\n${body}\n</${tag}>`;
  });
}

/**
 * Cascading entity override across an ordered list of layer texts.
 *
 * Layers are passed in priority order, lowest to highest. When the same
 * top-level tag appears more than once (across or within layers), only the
 * LATEST occurrence survives — earlier occurrences are stripped from their
 * layer texts. The latest occurrence stays in its original position.
 *
 * "Top-level" means an open tag at column 0 with a matching close tag (via
 * backreference). Indented or inline XML — like the `<b>`, `<color=...>`,
 * `<center>` formatting markers used in DM narration — is never matched.
 *
 * Returns an array of the same length and order as the input, with each
 * layer's text rewritten.
 */
export function applyLayeredOverrides(layers: string[]): string[] {
  const lastOcc = new Map<string, { layerIdx: number; offset: number }>();
  for (let li = 0; li < layers.length; li++) {
    TOP_LEVEL_BLOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOP_LEVEL_BLOCK_RE.exec(layers[li])) !== null) {
      lastOcc.set(m[1], { layerIdx: li, offset: m.index });
    }
  }
  return layers.map((layer, li) =>
    layer.replace(TOP_LEVEL_BLOCK_RE, (match, tag: string, _body: string, offset: number) => {
      const winner = lastOcc.get(tag);
      if (!winner) return match;
      return winner.layerIdx === li && winner.offset === offset ? match : "";
    }),
  );
}
