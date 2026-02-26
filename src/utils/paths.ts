/** Normalize a path to use forward slashes (cross-platform). */
export function norm(p: string): string {
  return p.replace(/\\/g, "/");
}
