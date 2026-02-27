/** Regex to detect hex color codes (#abc or #aabbcc). */
const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{3}){1,2}\b/g;

export interface ColorMatch {
  color: string;
  index: number;
}

/** Find all hex color codes in a string. */
export function findColors(text: string): ColorMatch[] {
  const matches: ColorMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = HEX_COLOR_RE.exec(text)) !== null) {
    matches.push({ color: m[0], index: m.index });
  }
  return matches;
}
