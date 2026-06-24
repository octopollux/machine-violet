/**
 * Dialect tolerance for DM narration.
 *
 * The DM is taught a closed HTML-subset vocabulary (see `dm-directives.md`), but
 * smarter models reach for semantic HTML (`<strong>`, `<em>`, `<h2>`), structural
 * variants (`<b class="x">`, `<br/>`), and the occasional markdown. This pass runs
 * FIRST — before cross-line healing and before `parseFormatting` — and rewrites
 * those dialects into the canonical vocabulary as a string transform, so the heal
 * and parse stages only ever see `<b>/<i>/<u>/<sub>/<sup>/<center>/<right>/<code>/`
 * `<quote>/<color=#hex>/<br>`.
 *
 * It is a *tolerance net*, not the contract: anything it doesn't recognize is still
 * caught by `parseFormatting`'s strip-to-content fallback (INV-NO-LEAK), so this can
 * stay deliberately conservative. Block-level markdown (`-`/`1.` lists, `>` quotes,
 * `|` tables) is NOT handled here — that's the blockify stage, which needs the raw
 * line structure. Inline code spans are protected first so markup inside them is
 * left verbatim.
 */

// NUL — cannot occur in DM narration, so it is a collision-proof placeholder for
// protected inline-code spans. Built at runtime so the source stays plain ASCII
// (a literal NUL byte would make git treat this file as binary).
const SENTINEL = String.fromCharCode(0);

function protect(inner: string, store: string[]): string {
  const idx = store.length;
  store.push(inner);
  return `${SENTINEL}${idx}${SENTINEL}`;
}

// A well-formed tag: `<name>`, `</name>`, `<name/>`, or `<name key="v" …>` where
// an attribute section MUST contain `=`. The name must follow `<` immediately —
// so prose like `< B & C >` (space) or `<b & c>` (bareword "attrs", no `=`) is
// NOT matched and stays literal. Group 1 = optional `/` (close), group 2 = name.
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s+[^<>]*=[^<>]*?)?\s*\/?>/g;

/** Map one well-formed tag into the canonical vocabulary (or "" to drop it, or
 *  the original text to leave it for the parser's strip-to-content fallback). */
function rewriteTag(raw: string, close: boolean, name: string): string {
  switch (name.toLowerCase()) {
    case "strong": return close ? "</b>" : "<b>";
    case "em": return close ? "</i>" : "<i>";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return close ? "</b>" : "<b>";
    case "b": case "i": case "u": case "sub": case "sup":
    case "center": case "right": case "code": case "quote":
      // Canonical bare form — drops attributes and normalizes case.
      return close ? `</${name.toLowerCase()}>` : `<${name.toLowerCase()}>`;
    case "blockquote": return close ? "</quote>" : "<quote>"; // HTML synonym
    case "br": return "<br>";
    case "s": case "strike": case "del": return ""; // no strikethrough primitive
    default: return raw; // unknown tag — leave it for parseFormatting to strip
  }
}

/**
 * Rewrite one line of DM narration from its dialect into the canonical formatting
 * vocabulary. Pure and idempotent on already-canonical input.
 */
export function normalizeDialect(text: string): string {
  // Fast path: nothing markup-ish to rewrite.
  if (!text || !/[<*_`#[]/.test(text)) return text;

  const code: string[] = [];
  let s = text;

  // 1. Protect inline code spans (HTML and markdown) — markup inside is verbatim.
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, inner: string) => protect(inner, code));
  s = s.replace(/`([^`\n]+)`/g, (_m, inner: string) => protect(inner, code));

  // 2. HTML dialect → canonical tags (synonyms, attribute-strip, headings,
  //    <br> canonicalization, strikethrough drop). Only well-formed tags match,
  //    so prose with stray angle brackets is untouched.
  s = s.replace(TAG_RE, (m, close: string, name: string) => rewriteTag(m, close === "/", name));

  // 3. Markdown headings → bold (line level).
  s = s.replace(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/gm, "$1<b>$2</b>");

  // 4. <color …> — keep only the supported `=#hex` form; tolerate quotes/spaces.
  s = s.replace(/<\s*color\s*=\s*"?(#[0-9a-fA-F]{3,8})"?\s*>/gi, "<color=$1>")
       .replace(/<\s*\/\s*color\s*>/gi, "</color>");

  // 5. Inline markdown (block markdown is handled in blockify).
  s = s.replace(/!\[[^\]\n]*\]\([^)\n]+\)/g, "");            // ![alt](src) → (drop image)
  s = s.replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, "$1");          // [text](url) → text
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");          // **bold** (before *italic*)
  s = s.replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "<i>$1</i>"); // *italic*
  s = s.replace(/(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])/g, "<i>$1</i>");   // _italic_

  // 6. Restore protected code spans as canonical <code>…</code>.
  s = s.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"), (_m, n: string) => `<code>${code[+n]}</code>`);
  return s;
}
