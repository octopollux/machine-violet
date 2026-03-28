/**
 * Production GitIO adapter backed by isomorphic-git + node:fs.
 */
import git from "isomorphic-git";
import fs from "node:fs";
import nodePath from "node:path";
import type { GitIO } from "./campaign-repo.js";

/**
 * Collect all object OIDs reachable from HEAD by walking the commit graph
 * and each commit's tree recursively.
 */
async function collectReachableOids(dir: string): Promise<Set<string>> {
  const reachable = new Set<string>();

  // Walk all commits from HEAD
  let commits: { oid: string; commit: { tree: string } }[];
  try {
    commits = await git.log({ fs, dir, depth: Infinity });
  } catch {
    return reachable;
  }

  for (const entry of commits) {
    reachable.add(entry.oid);
    // Walk the tree for this commit
    await walkTree(dir, entry.commit.tree, reachable);
  }

  return reachable;
}

/** Recursively walk a tree object, collecting all tree and blob OIDs. */
async function walkTree(dir: string, treeOid: string, reachable: Set<string>): Promise<void> {
  if (reachable.has(treeOid)) return;
  reachable.add(treeOid);

  let result: { tree: { mode: string; path: string; oid: string; type: string }[] };
  try {
    result = await git.readTree({ fs, dir, oid: treeOid });
  } catch {
    return;
  }

  for (const entry of result.tree) {
    if (entry.type === "tree") {
      await walkTree(dir, entry.oid, reachable);
    } else {
      reachable.add(entry.oid);
    }
  }
}

/**
 * Scan .git/objects/ for loose object files and return their OIDs.
 * Loose objects live at .git/objects/xx/yyyyyy... (2-char dir + 38-char file).
 */
async function listLooseObjects(dir: string): Promise<string[]> {
  const objectsDir = nodePath.join(dir, ".git", "objects");
  const oids: string[] = [];

  let prefixDirs: string[];
  try {
    prefixDirs = await fs.promises.readdir(objectsDir);
  } catch {
    return oids;
  }

  for (const prefix of prefixDirs) {
    // Skip non-hex dirs (info, pack, etc.)
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    const prefixPath = nodePath.join(objectsDir, prefix);
    let files: string[];
    try {
      files = await fs.promises.readdir(prefixPath);
    } catch {
      continue;
    }
    for (const file of files) {
      oids.push(prefix + file);
    }
  }

  return oids;
}

export function createGitIO(): GitIO {
  return {
    async init(dir) {
      await git.init({ fs, dir });
    },

    async add(dir, filepath) {
      await git.add({ fs, dir, filepath });
    },

    async remove(dir, filepath) {
      await git.remove({ fs, dir, filepath });
    },

    async commit(dir, message, author) {
      return git.commit({ fs, dir, message, author });
    },

    async log(dir, depth = 50) {
      const entries = await git.log({ fs, dir, depth });
      return entries.map((e) => ({
        oid: e.oid,
        commit: {
          message: e.commit.message,
          author: { timestamp: e.commit.author.timestamp },
        },
      }));
    },

    async checkout(dir, oid) {
      // isomorphic-git: `ref` with a full SHA updates the working tree;
      // the `oid` param alone only updates HEAD/index without touching files.
      await git.checkout({ fs, dir, ref: oid, force: true });
    },

    async resetTo(dir, oid) {
      // 1. Determine which branch HEAD points to (usually "master")
      const branch = await git.currentBranch({ fs, dir }) ?? "master";

      // 2. Update working tree to target commit
      await git.checkout({ fs, dir, ref: oid, force: true });

      // 3. Move the branch ref to the target commit (truncates history)
      await git.writeRef({
        fs, dir,
        ref: `refs/heads/${branch}`,
        value: oid,
        force: true,
      });

      // 4. Re-attach HEAD to the branch (avoids detached HEAD)
      await git.checkout({ fs, dir, ref: branch });
    },

    async pruneUnreachable(dir) {
      const reachable = await collectReachableOids(dir);
      const looseOids = await listLooseObjects(dir);
      const objectsDir = nodePath.join(dir, ".git", "objects");
      let pruned = 0;

      for (const oid of looseOids) {
        if (reachable.has(oid)) continue;

        const prefix = oid.slice(0, 2);
        const rest = oid.slice(2);
        const objectPath = nodePath.join(objectsDir, prefix, rest);
        try {
          await fs.promises.unlink(objectPath);
          pruned++;
        } catch {
          // Already gone or permission error — skip
        }

        // Try to remove the prefix dir if empty
        try {
          await fs.promises.rmdir(nodePath.join(objectsDir, prefix));
        } catch {
          // Not empty — expected
        }
      }

      return pruned;
    },

    async statusMatrix(dir) {
      return git.statusMatrix({ fs, dir });
    },

    async listFiles(dir) {
      return git.listFiles({ fs, dir });
    },
  };
}
