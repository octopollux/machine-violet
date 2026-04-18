import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllWorlds, worldSummaries } from "./world-loader.js";
import type { WorldFile } from "@machine-violet/shared/types/world.js";

// --- Bundled seed validation (uses real filesystem, no mocks) ---

/**
 * Resolve the bundled worlds directory.
 * In dev (vitest), this is ../../worlds relative to packages/engine/.
 */
function bundledWorldsDir(): string {
  return join(import.meta.dirname, "../../../../worlds");
}

describe("bundled .mvworld seed validation", () => {
  const dir = bundledWorldsDir();
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".mvworld"));

  it("has at least 50 bundled seeds", () => {
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  for (const file of files) {
    it(`${file} is valid JSON with required WorldFile fields`, () => {
      const raw = readFileSync(join(dir, file), "utf-8");
      const data = JSON.parse(raw);

      // Required fields
      expect(data.format).toBe("machine-violet-world");
      expect(data.version).toBe(1);
      expect(typeof data.name).toBe("string");
      expect(data.name.length).toBeGreaterThan(0);
      expect(typeof data.summary).toBe("string");
      expect(data.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(data.genres)).toBe(true);
      expect(data.genres.length).toBeGreaterThan(0);
      expect(data.genres.every((g: unknown) => typeof g === "string")).toBe(true);

      // Optional fields have correct types when present
      if (data.description !== undefined) {
        expect(typeof data.description).toBe("string");
      }
      if (data.detail !== undefined) {
        expect(typeof data.detail).toBe("string");
        // Detail should not contain <suboptions> XML — those should be extracted
        expect(data.detail).not.toMatch(/<suboptions/);
      }
      if (data.suboptions !== undefined) {
        expect(Array.isArray(data.suboptions)).toBe(true);
        for (const sub of data.suboptions) {
          expect(typeof sub.label).toBe("string");
          expect(Array.isArray(sub.choices)).toBe(true);
          for (const choice of sub.choices) {
            expect(typeof choice.name).toBe("string");
            expect(typeof choice.description).toBe("string");
          }
        }
      }
    });
  }
});

// --- World loader unit tests ---

function makeWorld(overrides?: Partial<WorldFile>): WorldFile {
  return {
    format: "machine-violet-world",
    version: 1,
    name: "Test World",
    summary: "A test world.",
    genres: ["fantasy"],
    ...overrides,
  };
}

describe("loadAllWorlds — user world warnings", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length) {
      const d = tempDirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeUserDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mv-worlds-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("warns and skips user world files with unparseable JSON", () => {
    const userDir = makeUserDir();
    writeFileSync(join(userDir, "broken.mvworld"), "{ not valid json", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const worlds = loadAllWorlds(userDir);

    expect(worlds.find((w) => w.slug === "broken")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("broken.mvworld");
    expect(msg).toContain("[worlds]");
  });

  it("warns and skips user world files that fail schema validation", () => {
    const userDir = makeUserDir();
    // Valid JSON but missing required fields (e.g. wrong format string).
    writeFileSync(join(userDir, "bad-schema.mvworld"), JSON.stringify({ format: "not-a-world", version: 1 }), "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const worlds = loadAllWorlds(userDir);

    expect(worlds.find((w) => w.slug === "bad-schema")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("bad-schema.mvworld");
    expect(msg).toContain("schema validation");
  });

  it("does not warn on valid user world files", () => {
    const userDir = makeUserDir();
    const good = makeWorld({ name: "Custom", summary: "Custom world." });
    writeFileSync(join(userDir, "custom.mvworld"), JSON.stringify(good), "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const worlds = loadAllWorlds(userDir);

    expect(worlds.find((w) => w.slug === "custom")).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("worldSummaries", () => {
  it("builds summaries from loaded worlds", () => {
    const worlds = [
      { slug: "test-world", world: makeWorld({ detail: "secret stuff", suboptions: [{ label: "Pick", choices: [{ name: "A", description: "Option A" }] }] }) },
      { slug: "minimal", world: makeWorld({ name: "Minimal", summary: "Bare bones.", detail: undefined }) },
    ];
    const summaries = worldSummaries(worlds);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].slug).toBe("test-world");
    expect(summaries[0].hasDetail).toBe(true);
    expect(summaries[0].hasSuboptions).toBe(true);
    expect(summaries[1].hasDetail).toBe(false);
    expect(summaries[1].hasSuboptions).toBe(false);
  });
});
