import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";

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
 * appears in multiple prompt LAYERS — main DM prompt, campaign seed prompt,
 * DM personality template prompt — the latest layer wins. Earlier
 * occurrences are removed entirely, and the latest layer's block stays in
 * place.
 *
 * This lets a DM personality redefine the `<NPCS>` block (or any other
 * entity) that the main DM prompt established, without editing the main
 * prompt file. Resolution is done at the buildDMPrefix layer; this module
 * just exposes the merge primitive.
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

const fileCache = new Map<string, IncludeFile>();

function loadIncludeFileFromDisk(name: string): IncludeFile {
  const cached = fileCache.get(name);
  if (cached) return cached;
  const path = join(assetDir("prompts"), "include", `${name}.md`);
  if (!existsSync(path)) {
    throw new Error(`Include file not found: prompts/include/${name}.md`);
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = parseIncludeFile(raw);
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

/** Clear the include-file cache. For tests. */
export function resetIncludeCache(): void {
  fileCache.clear();
}
