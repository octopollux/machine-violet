import { loadModelConfig } from "../config/models.js";
import { resetContentPromptCache } from "./prompts/load-content-prompt.js";
import { hasHandAuthoredRuleCard, copyBundledRuleCard, runRuleCardGen } from "./rule-card-gen.js";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FileIO } from "../agents/scene-manager.js";
import type Anthropic from "@anthropic-ai/sdk";

const norm = (p: string) => p.replace(/\\/g, "/");

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetContentPromptCache();
});

describe("hasHandAuthoredRuleCard", () => {
  it("returns true for bundled dnd-5e system", () => {
    // The repo has systems/dnd-5e/rule-card.md
    const projectRoot = process.cwd();
    expect(hasHandAuthoredRuleCard(projectRoot, "dnd-5e")).toBe(true);
  });

  it("returns false for non-existent system", () => {
    const projectRoot = process.cwd();
    expect(hasHandAuthoredRuleCard(projectRoot, "some-random-system")).toBe(false);
  });
});

describe("copyBundledRuleCard", () => {
  it("copies bundled rule card to output directory", () => {
    const projectRoot = process.cwd();
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

  const mockClient = {
    messages: {
      create: vi.fn(async () => ({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text: '<system name="Test">\n<core_mechanic>\nRoll dice.\n</core_mechanic>\n</system>' }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          inference_geo: null,
          server_tool_use: null,
          service_tier: null,
        },
      })),
    },
  } as unknown as Anthropic;

  it("skips when hand-authored rule card exists", async () => {
    const io = mockIO({});
    const projectRoot = process.cwd();
    const tempHome = join(tmpdir(), `mv-test-rulecard-${Date.now()}`);

    try {
      // dnd-5e has a hand-authored rule card — copies it to tempHome instead of generating
      const generated = await runRuleCardGen(mockClient, io, tempHome, "dnd-5e", projectRoot);
      expect(generated).toBe(false);
      expect(mockClient.messages.create).not.toHaveBeenCalled();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("generates rule card for new system", async () => {
    const freshClient = {
      messages: {
        create: vi.fn(async () => ({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "<system>Generated</system>" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: null,
            inference_geo: null,
            server_tool_use: null,
            service_tier: null,
          },
        })),
      },
    } as unknown as Anthropic;

    const io = mockIO({
      "/home/systems/new-system/entities/rules/combat.md": "# Combat\n\nRoll to hit.",
    });
    const projectRoot = process.cwd();

    const generated = await runRuleCardGen(freshClient, io, "/home", "new-system", projectRoot);
    expect(generated).toBe(true);

    const ruleCardPath = "/home/systems/new-system/rule-card.md";
    expect(io.files[ruleCardPath]).toContain("<system>");
  });
});
