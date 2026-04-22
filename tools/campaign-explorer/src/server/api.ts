import { Router } from "express";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { CampaignInfo, TreeEntry } from "../shared/protocol.js";
import { classifyPath, classifyMachinePath } from "./watcher.js";

/** Check that resolved absPath is inside dir (boundary-safe). */
function isInsideDir(dir: string, absPath: string): boolean {
  const resolved = resolve(absPath);
  const base = resolve(dir) + sep;
  return resolved.startsWith(base);
}

/**
 * Build the API router.
 * @param getCampaigns Function to get the current campaign list.
 * @param getCampaignPath Function to resolve a slug to its directory.
 * @param getMachineDir Function to resolve the machine-scope .debug directory (if any).
 */
export function createApiRouter(
  getCampaigns: () => CampaignInfo[],
  getCampaignPath: (slug: string) => string | undefined,
  getMachineDir?: () => string | null,
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
    const absPath = resolve(dir, relPath);
    if (!isInsideDir(dir, absPath)) {
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

  // --- Machine-scope routes ---

  router.get("/machine/tree", async (_req, res) => {
    const dir = getMachineDir?.();
    if (!dir) {
      res.json([]);
      return;
    }
    try {
      const entries = await walkDir(dir, dir, classifyMachinePath);
      res.json(entries);
    } catch {
      res.json([]);
    }
  });

  router.get("/machine/file/*path", async (req, res) => {
    const dir = getMachineDir?.();
    if (!dir) {
      res.status(404).json({ error: "Machine debug directory not available" });
      return;
    }

    const pathSegments = req.params.path;
    const relPath = Array.isArray(pathSegments) ? pathSegments.join("/") : String(pathSegments);
    if (!relPath) {
      res.status(400).json({ error: "Missing file path" });
      return;
    }

    const absPath = resolve(dir, relPath);
    if (!isInsideDir(dir, absPath)) {
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

  // Engine-log: parsed api:call events for per-turn stats display.
  // Reads .debug/engine.jsonl (same location as the machine-scope debug dir
  // for machine installs; falls back to the parent of the first campaign
  // path so that per-campaign dev trees also work).
  router.get("/engine-log/api-calls", async (req, res) => {
    const agent = typeof req.query.agent === "string" ? req.query.agent : undefined;
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 50));

    const logPath = resolveEngineLogPath(getMachineDir, getCampaigns, getCampaignPath);
    if (!logPath) {
      res.json([]);
      return;
    }

    try {
      const content = await readFile(logPath, "utf-8");
      const events: Array<Record<string, unknown>> = [];
      for (const line of content.split("\n")) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.event !== "api:call") continue;
          if (agent && obj.agent !== agent) continue;
          events.push(obj);
        } catch {
          // skip malformed line
        }
      }
      // Most-recent last in the file; return the tail.
      res.json(events.slice(-limit));
    } catch {
      res.json([]);
    }
  });

  return router;
}

/**
 * Locate engine.jsonl. Prefer the machine-scope .debug dir; fall back to
 * {dirname(campaignsDir)}/.debug for dev setups where machine mode is off.
 */
function resolveEngineLogPath(
  getMachineDir: (() => string | null) | undefined,
  getCampaigns: () => CampaignInfo[],
  getCampaignPath: (slug: string) => string | undefined,
): string | null {
  const machineDir = getMachineDir?.();
  if (machineDir) return join(machineDir, "engine.jsonl");

  // Fallback: siblings of the first campaign's parent
  const first = getCampaigns()[0];
  if (!first) return null;
  const path = getCampaignPath(first.slug);
  if (!path) return null;
  // campaign path = {campaignsDir}/{slug}; engine.jsonl at {dirname(campaignsDir)}/.debug
  return join(dirname(dirname(path)), ".debug", "engine.jsonl");
}

/** Recursively walk a directory and return tree entries. */
async function walkDir(
  root: string,
  dir: string,
  classifier: (relPath: string) => import("../shared/protocol.js").FileCategory = classifyPath,
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];

  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return entries;
  }

  for (const item of items) {
    // Skip dotfiles/dirs (except .debug) and node_modules
    if (item === "node_modules") continue;
    if (item.startsWith(".") && item !== ".debug") continue;

    const absPath = join(dir, item);
    try {
      const s = await stat(absPath);
      if (s.isDirectory()) {
        const subEntries = await walkDir(root, absPath, classifier);
        entries.push(...subEntries);
      } else {
        const relPath = relative(root, absPath).replace(/\\/g, "/");
        entries.push({
          relativePath: relPath,
          category: classifier(relPath),
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
