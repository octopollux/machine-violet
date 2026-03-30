/**
 * Entity tree — campaign-wide registry of all entities.
 *
 * Built from disk on session load by scanning entity directories and
 * parsing front matter. Injected into DM and Scribe context so agents
 * can resolve entity names to file paths without guessing slugs.
 *
 * Updated incrementally during play when the Scribe creates or
 * modifies entities.
 */
import { join } from "node:path";
import { parseFrontMatter } from "./frontmatter.js";
import { norm } from "../../utils/paths.js";
import type { EntityTree } from "@machine-violet/shared/types/entities.js";

/** Directories to scan, mapped to their entity type. */
const ENTITY_DIRS: { dir: string; type: string; subdirs: boolean }[] = [
  { dir: "characters", type: "character", subdirs: false },
  { dir: "locations", type: "location", subdirs: true },
  { dir: "factions", type: "faction", subdirs: false },
  { dir: "lore", type: "lore", subdirs: false },
];

/** Files to skip during entity scanning. */
const SKIP_FILES = new Set(["party.md", "notes.md"]);

interface TreeFileIO {
  readFile(path: string): Promise<string>;
  listDir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

/**
 * Build the entity tree by scanning all entity directories on disk.
 * Parses front matter from each entity file to extract name and aliases.
 */
export async function buildEntityTree(
  campaignRoot: string,
  fileIO: TreeFileIO,
): Promise<EntityTree> {
  const tree: EntityTree = {};

  for (const { dir, type, subdirs } of ENTITY_DIRS) {
    const dirPath = join(campaignRoot, dir);
    if (!(await fileIO.exists(dirPath))) continue;

    let entries: string[];
    try {
      entries = await fileIO.listDir(dirPath);
    } catch { continue; }

    for (const entry of entries) {
      if (SKIP_FILES.has(entry)) continue;

      let filePath: string;
      let slug: string;

      if (subdirs && !entry.endsWith(".md")) {
        // Subdirectory pattern (locations): slug/index.md
        const indexPath = norm(join(dirPath, entry, "index.md"));
        if (!(await fileIO.exists(indexPath))) continue;
        filePath = indexPath;
        slug = entry;
      } else if (entry.endsWith(".md")) {
        filePath = norm(join(dirPath, entry));
        slug = entry.replace(/\.md$/, "");
      } else {
        continue;
      }

      try {
        const raw = await fileIO.readFile(filePath);
        const { frontMatter } = parseFrontMatter(raw);
        const name = (frontMatter._title as string) || slug;
        const aliasRaw = frontMatter.additional_names as string | undefined;
        const aliases = aliasRaw
          ? aliasRaw.split(",").map((a) => a.trim()).filter(Boolean)
          : [];
        const relativePath = norm(filePath).replace(norm(campaignRoot) + "/", "");

        tree[slug] = { name, aliases, type, path: relativePath };
      } catch {
        // Skip files that can't be parsed
      }
    }
  }

  return tree;
}

/**
 * Render the entity tree as a compact string for context injection.
 * One line per entity: path — Name (type) aka Alias1, Alias2
 */
export function renderEntityTree(tree: EntityTree): string | undefined {
  const slugs = Object.keys(tree);
  if (slugs.length === 0) return undefined;

  const lines: string[] = [];
  for (const slug of slugs.sort()) {
    const e = tree[slug];
    const aliasSuffix = e.aliases.length > 0 ? ` aka ${e.aliases.join(", ")}` : "";
    lines.push(`${e.path} — ${e.name} (${e.type})${aliasSuffix}`);
  }
  return lines.join("\n");
}
