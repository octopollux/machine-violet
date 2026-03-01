/**
 * Production GitIO adapter backed by isomorphic-git + node:fs.
 */
import git from "isomorphic-git";
import fs from "node:fs";
import type { GitIO } from "./campaign-repo.js";

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

    async statusMatrix(dir) {
      return git.statusMatrix({ fs, dir });
    },

    async listFiles(dir) {
      return git.listFiles({ fs, dir });
    },
  };
}
