/**
 * Helpers for Lynx-style wikilink navigation in the compendium detail view.
 *
 * The compendium colorizer wraps `[[Name]]` in a `<wikilink slug=...>` AST
 * tag. These helpers walk that AST to:
 *   1. Collect every wikilink in document order, paired with the row index
 *      it sits on (so the modal can auto-scroll the selected link into view).
 *   2. Stamp `selected`/`broken` flags onto specific wikilink tags without
 *      mutating the input — render-nodes.tsx reads those flags to draw the
 *      inverse cursor and Wikipedia-style red broken links.
 *
 * Wikilink tags are never split across wrapped lines (wrapNodes treats each
 * tag as an atom), so each link maps cleanly to exactly one row.
 */

import { toPlainText } from "./formatting.js";
import type { FormattingNode, FormattingTag } from "@machine-violet/shared/types/tui.js";

export interface WikilinkRef {
  /** Slug parsed from the AST tag — the lookup key into the compendium. */
  slug: string;
  /** Display text from the original `[[Name]]`. */
  name: string;
  /** Zero-based index into the styledLines array this link occurs in. */
  rowIndex: number;
  /** Whether the slug resolves to an entry. Set by the resolver pass. */
  broken: boolean;
}

/**
 * Walk pre-wrapped styled lines and return wikilink refs in document order.
 *
 * `brokenSlugs` is the set of slugs that DO NOT resolve in the current
 * compendium — anything in this set gets `broken: true`. Pass an empty set
 * to mark all links live; pass a populated set to flag the absent ones.
 */
export function collectWikilinks(
  styledLines: FormattingNode[][],
  brokenSlugs: ReadonlySet<string>,
): WikilinkRef[] {
  const refs: WikilinkRef[] = [];
  for (let rowIndex = 0; rowIndex < styledLines.length; rowIndex++) {
    walk(styledLines[rowIndex], (tag) => {
      if (tag.type === "wikilink") {
        refs.push({
          slug: tag.target,
          name: toPlainText(tag.content),
          rowIndex,
          broken: brokenSlugs.has(tag.target),
        });
      }
    });
  }
  return refs;
}

/**
 * Return a new styledLines tree with `selected`/`broken` flags applied to
 * each wikilink based on its position in document order. Input is not
 * mutated — every tag along the spine of a marked link is rebuilt.
 *
 * `selectedIndex` is the index into the collectWikilinks() ordering; pass
 * -1 (or any out-of-range value) to leave nothing selected.
 */
export function markWikilinks(
  styledLines: FormattingNode[][],
  brokenSlugs: ReadonlySet<string>,
  selectedIndex: number,
): FormattingNode[][] {
  let counter = 0;
  return styledLines.map((line) =>
    mapNodes(line, (tag) => {
      if (tag.type !== "wikilink") return tag;
      const index = counter++;
      const broken = brokenSlugs.has(tag.target);
      const selected = index === selectedIndex;
      if (!broken && !selected) return tag;
      return { ...tag, broken: broken || undefined, selected: selected || undefined };
    }),
  );
}

function walk(nodes: FormattingNode[], visit: (tag: FormattingTag) => void): void {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    visit(node);
    walk(node.content, visit);
  }
}

/** Recurse through the tree, applying `transform` to every tag (post-order). */
function mapNodes(
  nodes: FormattingNode[],
  transform: (tag: FormattingTag) => FormattingTag,
): FormattingNode[] {
  return nodes.map((node) => {
    if (typeof node === "string") return node;
    const mappedContent = mapNodes(node.content, transform);
    const rebuilt = mappedContent === node.content ? node : ({ ...node, content: mappedContent } as FormattingTag);
    return transform(rebuilt);
  });
}
