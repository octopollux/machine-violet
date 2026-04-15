import { loadModelConfig } from "../config/models.js";
import { resetContentPromptCache } from "./prompts/load-content-prompt.js";
import { hasHandAuthoredRuleCard, copyBundledRuleCard, runRuleCardGen } from "./rule-card-gen.js";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Resolve repo root from this file's location (not cwd, which depends on which package
// vitest is invoked from).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
import type { FileIO } from "../agents/scene-manager.js";
import { makeMockProvider } from "./test-helpers.js";

const norm = (p: string) => p.replace(/\\/g, "/");

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetContentPromptCache();
});

describe("hasHandAuthoredRuleCard", () => {
  it("returns true for bundled dnd-5e system", () => {
    // The repo has systems/dnd-5e/rule-card.md
    const projectRoot = REPO_ROOT;
    expect(hasHandAuthoredRuleCard(projectRoot, "dnd-5e")).toBe(true);
  });

  it("returns false for non-existent system", () => {
    const projectRoot = REPO_ROOT;
    expect(hasHandAuthoredRuleCard(projectRoot, "some-random-system")).toBe(false);
  });
});

describe("copyBundledRuleCard", () => {
  it("copies bundled rule card to output directory", () => {
    const projectRoot = REPO_ROOT;
    const tempHome = join(tmpdir(), `mv-test-${Date.now()}`);

    try {
      copyBundledRuleCard(projectRoot, "dnd-5e", tempHome);

      const destPath = join(tempHome, "systems", "dnd-5e", "rule-card.md");
      expect(existsSync(destPath)).toBe(true);

      const srcContent = readFileSync(join(projectRoot, "systems", "dnd-5e", "rule-card.md"), "utf-8");
      const destContent = readFileSync(destPath, "utf-8");
      expect(destContent).toBe(srcContent);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe("runRuleCardGen", () => {
  function mockIO(initial: Record<string, string> = {}): FileIO & { files: Record<string, string> } {
    const files: Record<string, string> = { ...initial };
    return {
      files,
      readFile: vi.fn(async (p: string) => {
        const key = norm(p);
        for (const [k, v] of Object.entries(files)) {
          if (norm(k) === key) return v;
        }
        throw new Error(`ENOENT: ${p}`);
      }),
      writeFile: vi.fn(async (p: string, c: string) => { files[norm(p)] = c; }),
      appendFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      exists: vi.fn(async (p: string) => {
        const key = norm(p);
        return Object.keys(files).some((k) => {
          const nk = norm(k);
          return nk === key || nk.startsWith(key + "/");
        });
      }),
      listDir: vi.fn(async (p: string) => {
        const dir = norm(p);
        const entries = new Set<string>();
        for (const k of Object.keys(files)) {
          const nk = norm(k);
          if (nk.startsWith(dir + "/")) {
            const rest = nk.slice(dir.length + 1);
            entries.add(rest.split("/")[0]);
          }
        }
        return [...entries];
      }),
    };
  }

  const mockProvider = makeMockProvider('<system name="Test">\n<core_mechanic>\nRoll dice.\n</core_mechanic>\n</system>');

  it("skips when hand-authored rule card exists", async () => {
    const io = mockIO({});
    const projectRoot = REPO_ROOT;
    const tempHome = join(tmpdir(), `mv-test-rulecard-${Date.now()}`);

    try {
      // dnd-5e has a hand-authored rule card — copies it to tempHome instead of generating
      const generated = await runRuleCardGen(mockProvider, io, tempHome, "dnd-5e", projectRoot);
      expect(generated).toBe(false);
      expect(mockProvider.chat).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("generates rule card for new system", async () => {
    const freshProvider = makeMockProvider("<system>Generated</system>");

    const io = mockIO({
      "/home/systems/new-system/entities/rules/combat.md": "# Combat\n\nRoll to hit.",
    });
    const projectRoot = REPO_ROOT;

    const generated = await runRuleCardGen(freshProvider, io, "/home", "new-system", projectRoot);
    expect(generated).toBe(true);

    const ruleCardPath = "/home/systems/new-system/rule-card.md";
    expect(io.files[ruleCardPath]).toContain("<system>");
  });
});
