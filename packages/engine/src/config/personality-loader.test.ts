import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllPersonalities, getPersonality } from "./personality-loader.js";

// --- Bundled seed validation (uses real filesystem, no mocks) ---

/**
 * Resolve the bundled personalities directory.
 * In dev (vitest), this is ../../personalities relative to packages/engine/.
 */
function bundledPersonalitiesDir(): string {
  return join(import.meta.dirname, "../../../../personalities");
}

describe("bundled .mvdm seed validation", () => {
  const dir = bundledPersonalitiesDir();
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".mvdm"));

  it("ships at least a handful of personalities", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of files) {
    it(`${file} is valid JSON with required envelope + fields`, () => {
      const raw = readFileSync(join(dir, file), "utf-8");
      const data = JSON.parse(raw);

      // Envelope
      expect(data.format).toBe("machine-violet-dm");
      expect(data.version).toBe(1);

      // Required fields
      expect(typeof data.name).toBe("string");
      expect(data.name.length).toBeGreaterThan(0);
      expect(typeof data.prompt_fragment).toBe("string");
      expect(data.prompt_fragment.length).toBeGreaterThan(50);

      // Optional fields have correct types when present
      if (data.description !== undefined) {
        expect(typeof data.description).toBe("string");
      }
      if (data.detail !== undefined) {
        expect(typeof data.detail).toBe("string");
      }
    });
  }
});

describe("loadAllPersonalities — bundled load", () => {
  it("loads every bundled .mvdm file", () => {
    const personalities = loadAllPersonalities();
    const dir = bundledPersonalitiesDir();
    const fileCount = readdirSync(dir).filter((f) => f.endsWith(".mvdm")).length;
    expect(personalities.length).toBe(fileCount);
  });

  it("strips the file envelope (no format/version on returned objects)", () => {
    const personalities = loadAllPersonalities();
    for (const p of personalities) {
      expect(p).not.toHaveProperty("format");
      expect(p).not.toHaveProperty("version");
    }
  });
});

// --- User dir handling ---

describe("loadAllPersonalities — user dir warnings", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length) {
      const d = tempDirs.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeUserDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mv-personalities-test-"));
    tempDirs.push(dir);
    return dir;
  }

  it("warns and skips user files with unparseable JSON", () => {
    const userDir = makeUserDir();
    writeFileSync(join(userDir, "broken.mvdm"), "{ not valid json", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    loadAllPersonalities(userDir);

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("broken.mvdm");
    expect(msg).toContain("[personalities]");
  });

  it("warns and skips user files that fail schema validation", () => {
    const userDir = makeUserDir();
    writeFileSync(
      join(userDir, "bad-schema.mvdm"),
      JSON.stringify({ format: "not-a-dm", version: 1, name: "x", prompt_fragment: "y" }),
      "utf-8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    loadAllPersonalities(userDir);

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("bad-schema.mvdm");
    expect(msg).toContain("schema validation");
  });

  it("loads valid user personalities and lets them override bundled by name", () => {
    const userDir = makeUserDir();
    writeFileSync(
      join(userDir, "custom-chronicler.mvdm"),
      JSON.stringify({
        format: "machine-violet-dm",
        version: 1,
        name: "The Chronicler",
        prompt_fragment: "Custom Chronicler prompt that is at least fifty characters long to pass validation.",
      }),
      "utf-8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const personalities = loadAllPersonalities(userDir);
    const chronicler = personalities.find((p) => p.name === "The Chronicler");

    expect(chronicler).toBeDefined();
    expect(chronicler!.prompt_fragment).toContain("Custom Chronicler");
    expect(warn).not.toHaveBeenCalled();
  });
});

// --- getPersonality lookup ---

describe("getPersonality", () => {
  it("looks up a bundled personality by name", () => {
    const p = getPersonality("The Chronicler");
    expect(p).toBeDefined();
    expect(p!.name).toBe("The Chronicler");
    expect(p!.prompt_fragment).toContain("Chronicler");
  });

  it("returns undefined for unknown names", () => {
    expect(getPersonality("This Personality Does Not Exist")).toBeUndefined();
  });
});
