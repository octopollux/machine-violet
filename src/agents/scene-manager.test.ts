import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { SceneManager } from "./scene-manager.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { GameState } from "./game-state.js";
import { ConversationManager } from "../context/conversation.js";
import type { DMSessionState } from "./dm-prompt.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { norm } from "../utils/paths.js";

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
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
    },
  } as unknown as Anthropic;
}

function mockState(): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
    config: {
      name: "Test Campaign",
      dm_personality: { name: "grim", prompt_fragment: "Be terse." },
      players: [{ name: "Alice", character: "Aldric", type: "human" }],
      combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "often", player_overrides: {} },
    },
    campaignRoot: "/tmp/test-campaign",
    activePlayerIndex: 0,
  };
}

function mockScene(): SceneState {
  return {
    sceneNumber: 1,
    slug: "tavern-meeting",
    transcript: [
      "**[Aldric]** I enter the tavern.",
      "**DM:** The tavern is warm and dimly lit.",
    ],
    precis: "",
    playerReads: [],
    sessionNumber: 1,
  };
}

function mockSessionState(): DMSessionState {
  return {
    rulesAppendix: undefined,
    campaignSummary: undefined,
    sessionRecap: undefined,
    activeState: undefined,
    scenePrecis: undefined,
  };
}

let files: Record<string, string>;
let dirs: Set<string>;

function mockFileIO(): FileIO {
  return {
    readFile: vi.fn(async (path: string) => files[norm(path)] ?? ""),
    writeFile: vi.fn(async (path: string, content: string) => { files[norm(path)] = content; }),
    appendFile: vi.fn(async (path: string, content: string) => { files[norm(path)] = (files[norm(path)] ?? "") + content; }),
    mkdir: vi.fn(async (path: string) => { dirs.add(norm(path)); }),
    exists: vi.fn(async (path: string) => norm(path) in files || dirs.has(norm(path))),
    listDir: vi.fn(async () => []),
  };
}

beforeEach(() => {
  files = {};
  dirs = new Set();
});

describe("SceneManager", () => {
  it("appends player input and DM response to transcript", () => {
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    mgr.appendPlayerInput("Aldric", "I draw my sword.");
    mgr.appendDMResponse("The blade gleams in the candlelight.");
    mgr.appendToolResult("roll_dice", "1d20+5: [18]→23");

    const scene = mgr.getScene();
    expect(scene.transcript).toHaveLength(5); // 2 existing + 3 new
    expect(scene.transcript[2]).toContain("[Aldric]");
    expect(scene.transcript[3]).toContain("DM:");
    expect(scene.transcript[4]).toContain("roll_dice");
  });

  it("generates system prompt", () => {
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    const prompt = mgr.getSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt[0].text).toContain("Dungeon Master");
  });

  it("handles dropped exchange by updating precis", async () => {
    const client = mockClient([
      textResponse("Aldric entered the tavern. Warm, dimly lit."),
    ]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    const usage = await mgr.handleDroppedExchange(client, {
      exchange: {
        user: { role: "user", content: "I enter the tavern." },
        assistant: { role: "assistant", content: "The tavern is warm." },
        toolResults: [],
        estimatedTokens: 20,
        stubbed: false,
      },
      reason: "exchange_count",
    });

    expect(usage.inputTokens).toBe(50);
    expect(mgr.getScene().precis).toContain("Aldric entered the tavern");
  });

  it("accumulates player reads from dropped exchanges", async () => {
    const client = mockClient([
      textResponse('Aldric entered the tavern.\nPLAYER_READ: {"engagement":"high","focus":["exploration"],"tone":"curious","pacing":"exploratory","offScript":true}'),
    ]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    await mgr.handleDroppedExchange(client, {
      exchange: {
        user: { role: "user", content: "I enter the tavern." },
        assistant: { role: "assistant", content: "The tavern is warm." },
        toolResults: [],
        estimatedTokens: 20,
        stubbed: false,
      },
      reason: "exchange_count",
    });

    expect(mgr.getScene().playerReads).toHaveLength(1);
    expect(mgr.getScene().playerReads[0].engagement).toBe("high");
    expect(mgr.getScene().playerReads[0].tone).toBe("curious");
  });

  it("clears player reads on scene transition", async () => {
    const client = mockClient([
      textResponse("Summary"),
      textResponse(""),
    ]);

    const scene = mockScene();
    scene.playerReads = [
      { engagement: "high", focus: ["combat"], tone: "aggressive", pacing: "pushing_forward", offScript: false },
    ];

    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    await mgr.sceneTransition(client, "End of fight");
    expect(mgr.getScene().playerReads).toHaveLength(0);
  });

  it("executes scene_transition cascade", async () => {
    // Mock client: first call = scene summary, second call = changelog
    const client = mockClient([
      textResponse("- Aldric entered tavern\n- Met innkeeper"),
      textResponse("aldric.md: Entered tavern in Scene 1"),
    ]);

    const fileIO = mockFileIO();
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    const result = await mgr.sceneTransition(client, "Tavern Meeting");

    // Transcript was written
    expect(fileIO.writeFile).toHaveBeenCalled();
    expect(fileIO.mkdir).toHaveBeenCalled();

    // Campaign log was appended
    expect(fileIO.appendFile).toHaveBeenCalled();
    expect(result.campaignLogEntry).toContain("Aldric entered tavern");

    // Scene advanced
    expect(mgr.getScene().sceneNumber).toBe(2);
    expect(mgr.getScene().transcript).toHaveLength(0);
    expect(mgr.getScene().precis).toBe("");

    // Pending op cleared
    expect(mgr.getPendingOp()).toBeNull();

    // Usage accumulated (1 Haiku call — no entity files to update changelogs)
    expect(result.usage.inputTokens).toBe(50);
  });

  it("writes pending-operation.json during cascade", async () => {
    const client = mockClient([
      textResponse("Summary"),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.sceneTransition(client, "Test");

    // pending-operation.json was written multiple times during cascade
    const pendingOpCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: [string]) => path.includes("pending-operation"));
    expect(pendingOpCalls.length).toBeGreaterThanOrEqual(4);
  });

  it("advances calendar during scene transition", async () => {
    const client = mockClient([
      textResponse("Summary"),
      textResponse(""),
    ]);

    const state = mockState();
    const initialCalendar = state.clocks.calendar.current;

    const mgr = new SceneManager(
      state,
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    await mgr.sceneTransition(client, "Test", 120); // 120 minutes

    expect(state.clocks.calendar.current).toBe(initialCalendar + 120);
  });

  it("sessionEnd writes recap file", async () => {
    const client = mockClient([
      textResponse("- Session summary"),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.sessionEnd(client, "End of session");

    // Session recap file was written
    const recapCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: [string]) => path.includes("session-"));
    expect(recapCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("sessionResume loads recap and campaign log", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/campaign/session-recaps/session-000.md"] = "# Session 0 Recap\nThe adventure began.";
    files["/tmp/test-campaign/campaign/log.md"] = "# Campaign Log\n- Scene 1: Tavern";

    const sessionState = mockSessionState();
    const scene = mockScene();
    scene.sessionNumber = 1; // resuming session 1, so loads recap of session 0

    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    const recap = await mgr.sessionResume();
    expect(recap).toContain("adventure began");
    expect(sessionState.campaignSummary).toContain("Campaign Log");
  });
});
