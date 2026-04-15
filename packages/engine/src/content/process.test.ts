import { loadModelConfig } from "../config/models.js";
import { resetContentPromptCache } from "./prompts/load-content-prompt.js";
import { runProcessingPipeline } from "./process.js";
import type { ProcessingProgress } from "./process.js";
import type { FileIO } from "../agents/scene-manager.js";
import type Anthropic from "@anthropic-ai/sdk";

const norm = (p: string) => p.replace(/\\/g, "/");

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetContentPromptCache();
});

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

function mockUsage() {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    inference_geo: null,
    server_tool_use: null,
    service_tier: null,
  };
}

/** Classifier returns a catalog, extractor returns entities. */
function buildMockClient() {
  const classifierResult = JSON.stringify([
    { contentType: "rules", title: "Combat Rules", description: "Combat", startPage: 1, endPage: 5 },
  ]);

  const extractorResult = `--- ENTITY ---
Name: Attack Action
Category: rules
Slug: attack-action

**Type:** Rule
**Section:** Combat Rules

Make a melee or ranged attack.`;

  const cheatSheet = "# Cheat Sheet\n\nQuick ref.";
  const ruleCard = "<system>Generated</system>";

  let batchCallCount = 0;
  let createCallCount = 0;

  return {
    messages: {
      // oneShot calls for merge, cheat sheet, rule card
      create: vi.fn(async () => {
        createCallCount++;
        const text = createCallCount <= 1 ? cheatSheet : ruleCard;
        return {
          id: `msg_${createCallCount}`,
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: mockUsage(),
        };
      }),
      batches: {
        create: vi.fn(async (params: { requests: unknown[] }) => {
          batchCallCount++;
          return {
            id: `batch_${batchCallCount}`,
            processing_status: "ended",
            request_counts: { succeeded: params.requests.length, errored: 0, canceled: 0, expired: 0, processing: 0 },
          };
        }),
        retrieve: vi.fn(async (id: string) => ({
          id,
          processing_status: "ended",
          request_counts: { succeeded: 1, errored: 0, canceled: 0, expired: 0, processing: 0 },
        })),
        results: vi.fn(async function* (id: string) {
          const isClassifier = id === "batch_1";
          yield {
            custom_id: isClassifier ? "classify-test-system-1-5" : "extract-test-system-0-1-5",
            result: {
              type: "succeeded",
              message: {
                content: [{ type: "text", text: isClassifier ? classifierResult : extractorResult }],
              },
            },
          };
        }),
      },
    },
  } as unknown as Anthropic;
}

describe("runProcessingPipeline", () => {
  it("runs all stages end to end", async () => {
    const io = mockIO({
      // Cached page file for the source material
      "/home/ingest/cache/test-system/test-book/pages/0001.md": "Page 1: Combat rules...",
      "/home/ingest/cache/test-system/test-book/pages/0002.md": "Page 2: Attack actions...",
      "/home/ingest/cache/test-system/test-book/pages/0003.md": "Page 3: Damage rolls...",
      "/home/ingest/cache/test-system/test-book/pages/0004.md": "Page 4: Conditions...",
      "/home/ingest/cache/test-system/test-book/pages/0005.md": "Page 5: Death saves...",
    });

    const client = buildMockClient();
    const stages: string[] = [];

    await runProcessingPipeline({
      client,
      io,
      homeDir: "/home",
      collectionSlug: "test-system",
      jobSlug: "test-book",
      totalPages: 5,
      projectRoot: process.cwd(), // has dnd-5e but not test-system
      onProgress: (p: ProcessingProgress) => { stages.push(p.stage); },
    });

    // All stages should have been reached
    expect(stages).toContain("classifier");
    expect(stages).toContain("extractors");
    expect(stages).toContain("merge");
    expect(stages).toContain("index");
    expect(stages).toContain("rule-card");
    expect(stages).toContain("complete");

    // Pipeline state should be at "complete"
    const statePath = "/home/systems/test-system/pipeline.json";
    const state = JSON.parse(io.files[statePath]);
    expect(state.currentStage).toBe("complete");

    // Catalog should have been written
    const catalogPath = "/home/systems/test-system/catalog.json";
    expect(io.files[catalogPath]).toBeDefined();

    // Index should have been written
    const indexPath = "/home/systems/test-system/index.md";
    expect(io.files[indexPath]).toBeDefined();
  });

  it("resumes from saved state", async () => {
    const io = mockIO({
      // Pre-existing pipeline state at merge stage
      "/home/systems/test-system/pipeline.json": JSON.stringify({
        collectionSlug: "test-system",
        currentStage: "merge",
        updatedAt: new Date().toISOString(),
        stageData: {},
        batchIds: ["batch_old"],
      }),
      // Pre-existing draft entities (from completed extractor stage)
      "/home/systems/test-system/drafts/rules/attack-action.md": "# Attack Action\n\n**Type:** Rule\n\nMake an attack.",
    });

    const client = buildMockClient();
    const stages: string[] = [];

    await runProcessingPipeline({
      client,
      io,
      homeDir: "/home",
      collectionSlug: "test-system",
      jobSlug: "test-book",
      totalPages: 5,
      projectRoot: process.cwd(),
      onProgress: (p: ProcessingProgress) => { stages.push(p.stage); },
    });

    // Should NOT have run classifier or extractors
    expect(stages).not.toContain("classifier");
    expect(stages).not.toContain("extractors");

    // Should have run merge, index, rule-card
    expect(stages).toContain("merge");
    expect(stages).toContain("index");
    expect(stages).toContain("rule-card");
    expect(stages).toContain("complete");

    // Batch create should NOT have been called (stages 1-2 skipped)
    expect(client.messages.batches.create).not.toHaveBeenCalled();
  });
});
