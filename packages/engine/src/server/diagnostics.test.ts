import { describe, it, expect, beforeEach } from "vitest";
import { collectDiagnostics } from "./diagnostics.js";
import { unzipBinaryFiles } from "../utils/archive.js";
import type { ArchiveFileIO } from "../config/campaign-archive.js";
import { norm } from "../utils/paths.js";

/**
 * Build an in-memory ArchiveFileIO over a Record<path, content>.
 * Directories are inferred from the path map (any path that has children
 * underneath it is a directory).
 */
function makeMemFs(seed: Record<string, Uint8Array | string> = {}): {
  io: ArchiveFileIO;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(seed)) {
    const normalized = norm(path);
    files.set(normalized, typeof content === "string" ? new TextEncoder().encode(content) : content);
  }

  const isDirPath = (p: string): boolean => {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  };

  const io: ArchiveFileIO = {
    readFile: async (path) => {
      const buf = files.get(norm(path));
      if (!buf) throw new Error(`ENOENT: ${path}`);
      return new TextDecoder().decode(buf);
    },
    readBinary: async (path) => {
      const buf = files.get(norm(path));
      if (!buf) throw new Error(`ENOENT: ${path}`);
      return buf;
    },
    writeFile: async (path, content) => {
      files.set(norm(path), new TextEncoder().encode(content));
    },
    writeBinary: async (path, data) => {
      files.set(norm(path), data);
    },
    mkdir: async () => { /* dirs are implicit */ },
    exists: async (path) => {
      const p = norm(path);
      return files.has(p) || isDirPath(p);
    },
    listDir: async (path) => {
      const p = norm(path);
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const children = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        children.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      if (children.size === 0 && !isDirPath(p)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return [...children];
    },
    deleteFile: async (path) => { files.delete(norm(path)); },
    rmdir: async () => { /* no-op */ },
    fileMtime: async () => null,
    isDirectory: async (path) => isDirPath(norm(path)),
  };

  return { io, files };
}

describe("collectDiagnostics", () => {
  let io: ArchiveFileIO;
  let files: Map<string, Uint8Array>;

  beforeEach(() => {
    const fs = makeMemFs({
      // Campaign folder
      "/home/campaigns/my-campaign/config.json": JSON.stringify({ name: "Test Quest" }),
      "/home/campaigns/my-campaign/state/display-log.md": "scene 1 events",
      "/home/campaigns/my-campaign/.debug/crash-1.txt": "stack trace inside campaign",
      // Top-level .debug
      "/home/.debug/engine.jsonl": "{\"event\":\"start\"}\n",
      "/home/.debug/server.log": "boot ok",
      "/home/.debug/context/dump-1.txt": "ctx dump",
    });
    io = fs.io;
    files = fs.files;
  });

  it("zips campaign files under campaign/ and top-level .debug under .debug/", async () => {
    const result = await collectDiagnostics(
      "/home/campaigns/my-campaign",
      "/home",
      io,
    );
    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();

    const zipped = files.get(norm(result.path!));
    expect(zipped).toBeDefined();
    const entries = unzipBinaryFiles(zipped!);
    expect(entries).not.toBeNull();
    const keys = Object.keys(entries!).sort();

    // Campaign content prefixed with campaign/
    expect(keys).toContain("campaign/config.json");
    expect(keys).toContain("campaign/state/display-log.md");
    // Per-campaign .debug is captured via the campaign walk
    expect(keys).toContain("campaign/.debug/crash-1.txt");

    // Top-level .debug content prefixed with .debug/
    expect(keys).toContain(".debug/engine.jsonl");
    expect(keys).toContain(".debug/server.log");
    expect(keys).toContain(".debug/context/dump-1.txt");

    // Manifest is present
    expect(keys).toContain("manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(entries!["manifest.json"]));
    expect(manifest.campaignName).toBe("Test Quest");
    expect(manifest.campaignRoot).toBe(norm("/home/campaigns/my-campaign"));
    expect(typeof manifest.collectedAt).toBe("string");
    expect(manifest.platform).toBe(process.platform);
  });

  it("writes the zip under <homeDir>/diagnostics with a sanitized name and timestamp", async () => {
    const result = await collectDiagnostics(
      "/home/campaigns/my-campaign",
      "/home",
      io,
    );
    expect(result.ok).toBe(true);
    expect(result.path!).toMatch(/\/home\/diagnostics\/Test Quest-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/);
  });

  it("works when the top-level .debug folder is absent", async () => {
    // Build a fs without /home/.debug
    const fs = makeMemFs({
      "/home/campaigns/my-campaign/config.json": JSON.stringify({ name: "Lonely" }),
      "/home/campaigns/my-campaign/state/display-log.md": "x",
    });
    const result = await collectDiagnostics(
      "/home/campaigns/my-campaign",
      "/home",
      fs.io,
    );
    expect(result.ok).toBe(true);
    const zipped = fs.files.get(norm(result.path!))!;
    const entries = unzipBinaryFiles(zipped)!;
    const keys = Object.keys(entries);
    // No .debug entries, but campaign + manifest still there
    expect(keys.some((k) => k.startsWith(".debug/"))).toBe(false);
    expect(keys).toContain("campaign/config.json");
    expect(keys).toContain("manifest.json");
  });

  it("returns an error when nothing can be collected", async () => {
    const fs = makeMemFs({});
    const result = await collectDiagnostics(
      "/home/campaigns/missing",
      "/home",
      fs.io,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty|unreadable|nothing/i);
  });

  it("falls back to directory basename when config.json is missing or invalid", async () => {
    const fs = makeMemFs({
      "/home/campaigns/no-config-here/state/display-log.md": "x",
    });
    const result = await collectDiagnostics(
      "/home/campaigns/no-config-here",
      "/home",
      fs.io,
    );
    expect(result.ok).toBe(true);
    expect(result.path!).toMatch(/no-config-here-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/);
  });
});
