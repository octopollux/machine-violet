import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildOOCPrompt, buildOOCTools, buildOOCToolHandler, enterOOC } from "./ooc-mode.js";
import type { FileIO } from "../scene-manager.js";
import { CampaignRepo } from "../../tools/git/index.js";
import type { GitIO } from "../../tools/git/index.js";
import { loadModelConfig } from "../../config/models.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetPromptCache();
});

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: null };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function mockClient(responses: Anthropic.Message[]): Anthropic {
  let callIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[callIdx++]),
      stream: vi.fn(() => ({
        on: vi.fn(),
        finalMessage: vi.fn(async () => responses[callIdx++]),
      })),
    },
  } as unknown as Anthropic;
}

describe("buildOOCPrompt", () => {
  it("includes campaign name", () => {
    const prompt = buildOOCPrompt("Shadow of the Dragon");
    expect(prompt).toContain("Campaign: Shadow of the Dragon");
  });

  it("includes rules and character sheet when provided", () => {
    const prompt = buildOOCPrompt("TestCampaign", "FATE rules here", "Aldric the Bold");
    expect(prompt).toContain("Game system rules:\nFATE rules here");
    expect(prompt).toContain("Active character:\nAldric the Bold");
  });

  it("omits optional blocks when absent", () => {
    const prompt = buildOOCPrompt("TestCampaign");
    expect(prompt).not.toContain("Game system rules:");
    expect(prompt).not.toContain("Active character:");
    expect(prompt).not.toContain("undefined");
  });
});

describe("enterOOC", () => {
  it("returns summary from first sentence", async () => {
    const client = mockClient([textResponse("Grappling lets you restrain foes. You need a STR check.")]);
    const result = await enterOOC(client, "How does grappling work?", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toBe("Grappling lets you restrain foes.");
  });

  it("truncates summary over 100 chars", async () => {
    const longText = "A".repeat(110) + ". More text here.";
    const client = mockClient([textResponse(longText)]);
    const result = await enterOOC(client, "Tell me everything", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toHaveLength(100);
    expect(result.summary).toMatch(/\.\.\.$/);
  });

  it("defaults summary for text without sentence boundary", async () => {
    const client = mockClient([textResponse("")]);
    const result = await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.summary).toBe("OOC discussion.");
  });

  it("preserves snapshot with previousVariant and wasMidNarration", async () => {
    const client = mockClient([textResponse("Sure thing.")]);
    const result = await enterOOC(client, "pause", {
      campaignName: "Test",
      previousVariant: "narrating",
      wasMidNarration: true,
    });
    expect(result.snapshot.previousVariant).toBe("narrating");
    expect(result.snapshot.wasMidNarration).toBe(true);
  });

  it("defaults wasMidNarration to false", async () => {
    const client = mockClient([textResponse("Ok.")]);
    const result = await enterOOC(client, "pause", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.snapshot.wasMidNarration).toBe(false);
  });

  it("uses stream when onStream callback provided", async () => {
    const client = mockClient([textResponse("Response.")]);
    const onStream = vi.fn();
    await enterOOC(client, "question", {
      campaignName: "Test",
      previousVariant: "playing",
    }, onStream);
    expect(client.messages.stream).toHaveBeenCalled();
  });

  it("accumulates usage stats", async () => {
    const client = mockClient([textResponse("Done.")]);
    const result = await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("passes tools when repo is provided", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    const client = mockClient([textResponse("Done.")]);
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      repo,
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toHaveLength(1);
      expect(createCall.tools[0].name).toBe("get_commit_log");
    }
  });

  it("works without tools when repo not provided", async () => {
    const client = mockClient([textResponse("Done.")]);
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toBeUndefined();
    }
  });

  it("passes 4 tools when fileIO and campaignRoot are provided", async () => {
    const client = mockClient([textResponse("Done.")]);
    const fio = mockFileIO();
    await enterOOC(client, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      fileIO: fio,
      campaignRoot: "/camp",
    });

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (createCall) {
      expect(createCall.tools).toHaveLength(4);
      const names = createCall.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("find_references");
      expect(names).toContain("validate_campaign");
      expect(names).toContain("get_commit_log");
    }
  });
});

// --- Git mock ---

const MOCK_BASE_TS = Math.floor(new Date("2025-03-15T12:00:00Z").getTime() / 1000);

function mockGitIO(): GitIO {
  const commits: { message: string; oid: string; timestamp: number }[] = [];
  const staged = new Set<string>();
  let oidCounter = 0;

  return {
    init: vi.fn(async () => {}),
    add: vi.fn(async (_dir, filepath) => { staged.add(filepath); }),
    commit: vi.fn(async (_dir, message) => {
      const oid = `commit_${++oidCounter}`;
      commits.unshift({ message, oid, timestamp: MOCK_BASE_TS + oidCounter * 86400 });
      staged.clear();
      return oid;
    }),
    log: vi.fn(async (_dir, depth = 50) =>
      commits.slice(0, depth).map((c) => ({
        oid: c.oid,
        commit: { message: c.message, author: { timestamp: c.timestamp } },
      })),
    ),
    checkout: vi.fn(async () => {}),
    statusMatrix: vi.fn(async () =>
      staged.size > 0
        ? [...staged].map((f) => [f, 1, 2, 2] as [string, number, number, number])
        : [["config.json", 1, 2, 1] as [string, number, number, number]],
    ),
    listFiles: vi.fn(async () => ["config.json"]),
    remove: vi.fn(async () => {}),
  };
}

// --- OOC tools ---

function mockFileIO(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
): FileIO {
  return {
    readFile: vi.fn(async (p: string) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => p in files || p in dirs),
    listDir: vi.fn(async (p: string) => {
      if (p in dirs) return dirs[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    deleteFile: vi.fn(async () => {}),
  };
}

describe("buildOOCTools", () => {
  it("returns only get_commit_log when no fileIO", () => {
    const tools = buildOOCTools(false);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_commit_log");
  });

  it("returns 4 tools when fileIO is available", () => {
    const tools = buildOOCTools(true);
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["get_commit_log", "read_file", "find_references", "validate_campaign"]);
  });
});

describe("buildOOCToolHandler", () => {
  it("returns commit log with distinct dates", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.sceneCommit("The Dragon's Lair");
    await repo.autoCommit("auto: exchanges");

    const handler = buildOOCToolHandler(repo);
    const result = await handler("get_commit_log", {});
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("[scene]");
    expect(result.content).toContain("Dragon's Lair");
    expect(result.content).toContain("2025-03-");
    const dateMatches = result.content.match(/\((\d{4}-\d{2}-\d{2})/g) ?? [];
    const uniqueDates = new Set(dateMatches);
    expect(uniqueDates.size).toBeGreaterThan(1);
  });

  it("filters by type", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.sceneCommit("The Dragon's Lair");
    await repo.autoCommit("auto: exchanges");

    const handler = buildOOCToolHandler(repo);
    const result = await handler("get_commit_log", { type: "scene" });
    expect(result.content).toContain("[scene]");
    expect(result.content).not.toContain("[auto]");
  });

  it("returns error for unknown tool", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    const handler = buildOOCToolHandler(repo);
    const result = await handler("nonexistent", {});
    expect(result.is_error).toBe(true);
  });

  it("read_file reads a campaign file", async () => {
    const fio = mockFileIO({
      "/camp/characters/kael.md": "# Kael\n**Type:** PC",
    });
    const handler = buildOOCToolHandler(undefined, "/camp", fio);

    const result = await handler("read_file", { path: "characters/kael.md" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("# Kael\n**Type:** PC");
  });

  it("read_file rejects path traversal", async () => {
    const fio = mockFileIO();
    const handler = buildOOCToolHandler(undefined, "/camp", fio);

    const result = await handler("read_file", { path: "../etc/passwd" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Path traversal not allowed");
  });

  it("read_file errors without fileIO", async () => {
    const handler = buildOOCToolHandler();
    const result = await handler("read_file", { path: "characters/kael.md" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("File I/O not available");
  });

  it("find_references returns references for a target entity", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael\n**Type:** PC",
        "/camp/campaign/log.md": "Met [Kael](../characters/kael.md) at the tavern.",
      },
      {
        "/camp/characters": ["kael.md"],
      },
    );
    const handler = buildOOCToolHandler(undefined, "/camp", fio);

    const result = await handler("find_references", { path: "characters/kael.md" });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0].file).toBe("campaign/log.md");
  });

  it("validate_campaign returns validation report", async () => {
    const fio = mockFileIO(
      { "/camp/config.json": '{"name":"Test"}' },
      {
        "/camp/characters": [],
        "/camp/locations": [],
        "/camp/factions": [],
        "/camp/items": [],
        "/camp/lore": [],
      },
    );
    const handler = buildOOCToolHandler(undefined, "/camp", fio);

    const result = await handler("validate_campaign", {});
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveProperty("issues");
    expect(parsed).toHaveProperty("errorCount");
  });
});
