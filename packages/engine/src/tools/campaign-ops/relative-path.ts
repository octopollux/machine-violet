/**
 * Compute a relative path from one file to another.
 * Inverse of resolveRelativePath — produces a path that, when resolved
 * from fromFile's directory, yields toFile.
 *
 * All paths use forward slashes and are relative to campaign root.
 */
export function computeRelativePath(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split("/").slice(0, -1); // directory of source file
  const toParts = toFile.split("/");

  // Find longest common prefix
  let common = 0;
  while (
    common < fromDir.length &&
    common < toParts.length &&
    fromDir[common] === toParts[common]
  ) {
    common++;
  }

  // Number of ".." needed to ascend from fromDir to common ancestor
  const ups = fromDir.length - common;
  const segments: string[] = [];
  for (let i = 0; i < ups; i++) {
    segments.push("..");
  }

  // Append remaining path segments of toFile
  for (let i = common; i < toParts.length; i++) {
    segments.push(toParts[i]);
  }

  return segments.join("/");
}
