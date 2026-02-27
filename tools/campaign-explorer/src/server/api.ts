import { Router } from "express";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CampaignInfo, TreeEntry } from "../shared/protocol.js";
import { classifyPath } from "./watcher.js";

/**
 * Build the API router.
 * @param getCampaigns Function to get the current campaign list.
 * @param getCampaignPath Function to resolve a slug to its directory.
 */
export function createApiRouter(
  getCampaigns: () => CampaignInfo[],
  getCampaignPath: (slug: string) => string | undefined,
): Router {
  const router = Router();

  // List all campaigns
  router.get("/campaigns", (_req, res) => {
    res.json(getCampaigns());
  });

  // Get file tree for a campaign
  router.get("/campaigns/:slug/tree", async (req, res) => {
    const dir = getCampaignPath(req.params.slug);
    if (!dir) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    try {
      const entries = await walkDir(dir, dir);
      res.json(entries);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Get file content
  router.get("/campaigns/:slug/file/*path", async (req, res) => {
    const dir = getCampaignPath(req.params.slug);
    if (!dir) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    // Express 5: wildcard params are string[]
    const pathSegments = req.params.path;
    const relPath = Array.isArray(pathSegments) ? pathSegments.join("/") : String(pathSegments);
    if (!relPath) {
      res.status(400).json({ error: "Missing file path" });
      return;
    }

    // Security: prevent path traversal
    const absPath = join(dir, relPath);
    if (!absPath.startsWith(dir)) {
      res.status(403).json({ error: "Path traversal not allowed" });
      return;
    }

    try {
      const content = await readFile(absPath, "utf-8");
      const ext = relPath.split(".").pop()?.toLowerCase();
      if (ext === "json") {
        res.type("application/json").send(content);
      } else {
        res.type("text/plain").send(content);
      }
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  return router;
}

/** Recursively walk a directory and return tree entries. */
async function walkDir(root: string, dir: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];

  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return entries;
  }

  for (const item of items) {
    // Skip dotfiles/dirs (except .dev-mode and .debug) and node_modules
    if (item === "node_modules") continue;
    if (item.startsWith(".") && item !== ".dev-mode" && item !== ".debug") continue;

    const absPath = join(dir, item);
    try {
      const s = await stat(absPath);
      if (s.isDirectory()) {
        const subEntries = await walkDir(root, absPath);
        entries.push(...subEntries);
      } else {
        const relPath = relative(root, absPath).replace(/\\/g, "/");
        entries.push({
          relativePath: relPath,
          category: classifyPath(relPath),
          size: s.size,
          mtime: s.mtime.toISOString(),
        });
      }
    } catch {
      // Skip inaccessible files
    }
  }

  return entries;
}
