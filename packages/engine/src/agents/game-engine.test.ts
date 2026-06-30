import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import type { LLMProvider, ChatResult, TierProvider, NormalizedMessage } from "../providers/types.js";
import { campaignPaths } from "../tools/filesystem/index.js";
import { GameEngine } from "./game-engine.js";
import { setTraceSink, resetTraceLog } from "../context/trace.js";
import type { SpanRecord } from "../context/trace.js";
import { pruneEmptyDirs } from "../tools/git/index.js";
import type { EngineCallbacks, EngineState, TurnInfo } from "./game-engine.js";
import type { GameState } from "./game-state.js";
import type { ModelTier } from "@machine-violet/shared/types/engine.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { DMSessionState } from "./dm-prompt.js";
import type { TuiCommand, UsageStats } from "./agent-loop.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";

/**
 * Test-only convenience: build a homogeneous tierProviders map from a single
 * provider. Production constructs this from the connection store; tests stub
 * it because most assertions don't care which tier a call goes through.
 *
 * If a test does need to assert per-tier routing, it should construct a
 * heterogeneous map by hand and pass it as `tierProviders`.
 */
function tierProvidersForTest(provider: LLMProvider, dmModel?: string): Record<ModelTier, TierProvider> {
  return {
    large: { provider, model: dmModel ?? "claude-opus-4-6" },
    medium: { provider, model: "claude-sonnet-4-6" },
    small: { provider, model: "claude-haiku-4-5-20251001" },
  };
}

/**
 * Wraps `new GameEngine(...)` for tests, auto-filling `tierProviders` from
 * `params.provider` and `params.model`. Production code constructs
 * `tierProviders` explicitly via `buildTierProviders` — keeping the fallback
 * out of the engine itself preserves the no-silent-fallback invariant under
 * heterogeneous routing.
 */
function makeEngine(params: {
  provider: LLMProvider;
  gameState: GameState;
  scene: SceneState;
  sessionState: DMSessionState;
  fileIO: FileIO;
  callbacks: EngineCallbacks;
  model?: string;
  tierProviders?: Record<ModelTier, TierProvider>;
  gitIO?: import("../tools/git/index.js").GitIO;
  entityTree?: import("@machine-violet/shared/types/entities.js").EntityTree;
}): GameEngine {
  const tierProviders = params.tierProviders ?? tierProvidersForTest(params.provider, params.model);
  return new GameEngine({
    provider: params.provider,
    gameState: params.gameState,
    scene: params.scene,
    sessionState: params.sessionState,
    fileIO: params.fileIO,
    callbacks: params.callbacks,
    tierProviders,
    gitIO: params.gitIO,
    entityTree: params.entityTree,
  });
}

vi.mock("./subagents/ai-player.js", () => ({
  aiPlayerTurn: vi.fn(async () => ({
    text: "I attack the goblin.",
    action: "I attack the goblin.",
    usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));

vi.mock("./subagents/scribe.js", () => ({
  runScribe: vi.fn(async () => ({
    summary: "Created [[Grimjaw]] (character, private)",
    created: ["/tmp/test-campaign/characters/grimjaw.md"],
    updated: [],
    entityDeltas: [{ slug: "grimjaw", name: "Grimjaw", aliases: [], type: "character", path: "characters/grimjaw.md" }],
    removedSlugs: [],
    usage: { inputTokens: 30, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));

vi.mock("./subagents/character-promotion.js", () => ({
  promoteCharacter: vi.fn(async () => ({
    updatedSheet: "# Storm\n\n**Type:** PC\n\n## Skills\n- Hack (d8)\n",
    changelogEntry: "Built initial sheet",
    text: "",
    usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));

vi.mock("./subagents/scene-tracker.js", () => ({
  SCENE_TRACKER_CADENCE: 4,
  trackScene: vi.fn(async () => ({
    text: "THREADS: (none)",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    openThreads: "",
  })),
}));

import { aiPlayerTurn } from "./subagents/ai-player.js";
import { runScribe } from "./subagents/scribe.js";
import { promoteCharacter } from "./subagents/character-promotion.js";

function mockUsage() {
  return { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textMessage(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function toolAndTextMessages(
  toolName: string,
  toolInput: Record<string, unknown>,
  text: string,
): ChatResult[] {
  return [
    {
      text: "",
      toolCalls: [{ id: "toolu_1", name: toolName, input: toolInput }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [{ type: "tool_use", id: "toolu_1", name: toolName, input: toolInput }],
    },
    textMessage(text),
  ];
}

let providerCallIdx: number;

function mockProvider(responses: ChatResult[]): LLMProvider {
  providerCallIdx = 0;
  return {
    providerId: "mock",
    chat: vi.fn(async () => responses[providerCallIdx++]),
    stream: vi.fn(async (_params: unknown, _onDelta?: unknown) => responses[providerCallIdx++]),
    healthCheck: vi.fn(async () => ({ ok: true })),
  } as unknown as LLMProvider;
}

function mockState(): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
    objectives: createObjectivesState(),
    config: {
      name: "Test",
      dm_personality: { name: "grim", prompt_fragment: "Be terse." },
      players: [{ name: "Alice", character: "Aldric", type: "human" }],
      combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "never", player_overrides: {} },
    },
    campaignRoot: "/tmp/test-campaign",
    homeDir: "/tmp/home",
    activePlayerIndex: 0,
    displayResources: {},
    resourceValues: {},
  };
}

function mockScene(): SceneState {
  return {
    sceneNumber: 1,
    slug: "test-scene",
    transcript: [],
    precis: "",
    openThreads: "",
    npcIntents: "",

    playerReads: [],
    sessionNumber: 1,
    sessionRecapPending: false,
  };
}

function mockSessionState(): DMSessionState {
  return {};
}

import { norm } from "../utils/paths.js";
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

/** Real solid-color PNG bytes — valid input for sharp / loadCharacterReferences. */
async function pngBytes(size: number, rgb: { r: number; g: number; b: number }): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 3, background: rgb } }).png().toBuffer());
}

/** FileIO backed by an in-memory binary `store` (plus the text mockFileIO behavior). */
function binaryFileIO(store: Map<string, Uint8Array>): FileIO {
  return {
    ...mockFileIO(),
    exists: vi.fn(async (p: string) => store.has(norm(p)) || norm(p) in files || dirs.has(norm(p))),
    readBinaryFile: vi.fn(async (p: string) => {
      const k = norm(p);
      if (!store.has(k)) throw new Error(`ENOENT: ${p}`);
      return store.get(k)!;
    }),
    writeBinaryFile: vi.fn(async (p: string, b: Uint8Array) => { store.set(norm(p), b); }),
    listDir: vi.fn(async (p: string) => {
      const prefix = norm(p) + "/";
      const names = new Set<string>();
      for (const k of store.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
      return [...names];
    }),
  };
}

interface CallbackLog {
  states: EngineState[];
  narrativeDeltas: string[];
  narrativeComplete: string[];
  tuiCommands: TuiCommand[];
  toolStarts: string[];
  toolEnds: string[];
  errors: Error[];
  usageUpdates: UsageStats[];
  exchangeDrops: number;
  devLogs: string[];
  turnStarts: TurnInfo[];
  turnEnds: TurnInfo[];
}

function mockCallbacks(): { callbacks: EngineCallbacks; log: CallbackLog } {
  const log: CallbackLog = {
    states: [],
    narrativeDeltas: [],
    narrativeComplete: [],
    tuiCommands: [],
    toolStarts: [],
    toolEnds: [],
    errors: [],
    usageUpdates: [],
    exchangeDrops: 0,
    devLogs: [],
    turnStarts: [],
    turnEnds: [],
  };

  return {
    log,
    callbacks: {
      onNarrativeDelta: (delta) => log.narrativeDeltas.push(delta),
      onNarrativeComplete: (text) => log.narrativeComplete.push(text),
      onStateChange: (state) => log.states.push(state),
      onTuiCommand: (cmd) => log.tuiCommands.push(cmd),
      onToolStart: (name) => log.toolStarts.push(name),
      onToolEnd: (name) => log.toolEnds.push(name),
      onExchangeDropped: () => log.exchangeDrops++,
      onUsageUpdate: (delta) => log.usageUpdates.push({ ...delta }),
      onError: (error) => log.errors.push(error),
      onDevLog: (msg) => log.devLogs.push(msg),
      onRetry: () => {},
      onTurnStart: (turn) => log.turnStarts.push(turn),
      onTurnEnd: (turn) => log.turnEnds.push(turn),
    },
  };
}

beforeEach(() => {
  files = {};
  dirs = new Set();
});

describe("GameEngine", () => {
  it("processes player input and returns DM response", async () => {
    const provider = mockProvider([textMessage("The door creaks open.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I open the door.");

    expect(log.narrativeComplete).toContain("The door creaks open.");
    expect(log.states).toContain("dm_thinking");
    expect(log.states[log.states.length - 1]).toBe("waiting_input");
    expect(engine.getState()).toBe("waiting_input");
  });

  it("handles tool calls and collects TUI commands", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("style_scene", { key_color: "#cc4444" }, "The mood shifts."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I attack!");

    expect(log.tuiCommands).toHaveLength(1);
    expect(log.tuiCommands[0].type).toBe("set_theme");
    expect(log.toolStarts).toContain("style_scene");
    expect(log.toolEnds).toContain("style_scene");
  });

  it("renders generate_image fire-and-forget: ack now, image surfaces on a later turn", async () => {
    // generate_image no longer blocks the turn. The DM fires it, gets an
    // immediate ack, and keeps narrating; the (slow) render runs in the
    // background. While it cooks the engine REST state is "generating_image"
    // (but input stays unblocked), and the finished image surfaces — as a
    // display_image broadcast — at the NEXT turn boundary, divorced from the
    // turn it was requested on.
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((r) => { releaseRender = r; });
    const imageBatch: ChatResult = {
      text: "",
      toolCalls: [
        { id: "t1", name: "generate_image", input: { prompt: "a sword", effort: "standard", aspect: "square" } },
        { id: "t2", name: "roll_dice", input: { expression: "1d20" } },
      ],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "tool_use", id: "t1", name: "generate_image", input: { prompt: "a sword", effort: "standard", aspect: "square" } },
        { type: "tool_use", id: "t2", name: "roll_dice", input: { expression: "1d20" } },
      ],
    };
    const responses = [imageBatch, textMessage("Here it is."), textMessage("Onward.")];
    let idx = 0;
    const generateImage = vi.fn(async () => {
      // Gate the render so it's still in flight when turn 1 ends — deterministic,
      // no wall-clock races.
      await renderGate;
      return { base64: "AAA=", mimeType: "image/png", effortUsed: "standard", aspectUsed: "square" };
    });
    const provider = {
      providerId: "mock",
      chat: vi.fn(async () => responses[idx++]),
      stream: vi.fn(async () => responses[idx++]),
      healthCheck: vi.fn(async () => ({ ok: true })),
      getCapabilities: () => ({ imageGeneration: true, thinking: false, tools: true, streaming: true, caching: false }),
      generateImage,
    } as unknown as LLMProvider;
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: { ...mockFileIO(), writeBinaryFile: vi.fn(async () => {}) },
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Turn 1: the DM fires generate_image and finishes narrating while the
    // render is still gated. No image has surfaced yet...
    await engine.processInput("Aldric", "Show me the sword.");
    expect(log.tuiCommands.some((c) => c.type === "display_image")).toBe(false);
    // ...and the turn yields straight to the player (waiting_input) even though
    // the render is still in flight — the render is detached and never parks the
    // engine in a DM-looking state, so the player isn't made to wait it out.
    expect(engine.getState()).toBe("waiting_input");

    // Let the render finish; it queues itself for display.
    releaseRender();
    await engine.awaitPendingImageRenders();
    await Promise.resolve(); // flush the render's finally (set cleanup)
    expect(engine.getState()).toBe("waiting_input");

    // Turn 2: the completed image surfaces here — divorced from turn 1.
    await engine.processInput("Aldric", "I sheathe it.");
    const displayed = log.tuiCommands.filter((c) => c.type === "display_image");
    expect(displayed).toHaveLength(1);
    expect(displayed[0].intent).toBe("scene_snapshot");
    expect(engine.getState()).toBe("waiting_input");
  });

  it("renders an intent='player_request' image INLINE in the same turn (synchronous)", async () => {
    // The player explicitly asked, so they're waiting for THIS image: it renders
    // inline, shows in the same turn (display_image broadcast), and the engine
    // holds "generating_image" while they wait. Distinct from the background mode.
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((r) => { releaseRender = r; });
    let stateWhileRendering: string | undefined;
    const engineRef: { current?: { getState(): string } } = {};
    const imageBatch: ChatResult = {
      text: "",
      toolCalls: [
        { id: "t1", name: "generate_image", input: { prompt: "the dragon", effort: "quality", aspect: "landscape", intent: "player_request" } },
      ],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "tool_use", id: "t1", name: "generate_image", input: { prompt: "the dragon", effort: "quality", aspect: "landscape", intent: "player_request" } },
      ],
    };
    const responses = [imageBatch, textMessage("Here it is.")];
    let idx = 0;
    const generateImage = vi.fn(async () => {
      stateWhileRendering = engineRef.current!.getState();
      await renderGate;
      return { base64: "AAA=", mimeType: "image/png", effortUsed: "quality", aspectUsed: "landscape" };
    });
    const provider = {
      providerId: "mock",
      chat: vi.fn(async () => responses[idx++]),
      stream: vi.fn(async () => responses[idx++]),
      healthCheck: vi.fn(async () => ({ ok: true })),
      getCapabilities: () => ({ imageGeneration: true, thinking: false, tools: true, streaming: true, caching: false }),
      generateImage,
    } as unknown as LLMProvider;
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: { ...mockFileIO(), writeBinaryFile: vi.fn(async () => {}) },
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });
    engineRef.current = engine;

    // Start the turn but don't await — it blocks on the gated inline render.
    const turn = engine.processInput("Aldric", "Draw me the dragon.");
    await new Promise((r) => setTimeout(r, 0)); // let it reach the gated render
    // The render is in flight INSIDE this still-open turn, and the indicator is lit.
    expect(stateWhileRendering).toBe("generating_image");
    expect(engine.getState()).toBe("generating_image");
    expect(log.tuiCommands.some((c) => c.type === "display_image")).toBe(false);

    // Finish the render; the image shows in THIS turn, then the turn completes.
    releaseRender();
    await turn;
    const displayed = log.tuiCommands.filter((c) => c.type === "display_image");
    expect(displayed).toHaveLength(1);
    expect(displayed[0].intent).toBe("player_request");
    expect(engine.getState()).toBe("waiting_input");
  });

  it("update_portrait revises the portrait and hands the new image to the DM next turn (no extra turn)", async () => {
    const paths = campaignPaths("/tmp/test-campaign");
    const portraitPath = norm(paths.characterPortrait("Aldric"));
    const archivePath = norm(paths.characterPortraitArchive("Aldric", 1));
    const store = new Map<string, Uint8Array>();
    store.set(portraitPath, await pngBytes(64, { r: 1, g: 2, b: 3 }));
    const renderedPng = await pngBytes(800, { r: 200, g: 40, b: 40 });

    const capturedMessages: NormalizedMessage[][] = [];
    // A change with a newline + quote, to exercise marker sanitization.
    const change = 'left boot torn off,\nbare foot "muddy"';
    const responses: ChatResult[] = [
      {
        text: "",
        toolCalls: [{ id: "t1", name: "update_portrait", input: { character: "Aldric", change } }],
        usage: mockUsage(),
        stopReason: "tool_use",
        assistantContent: [{ type: "tool_use", id: "t1", name: "update_portrait", input: { character: "Aldric", change } }],
      },
      textMessage("Aldric's boot is wrenched off in the dark."),
      textMessage("He limps onward."),
    ];
    let idx = 0;
    const capture = async (p: { messages: NormalizedMessage[] }) => { capturedMessages.push(p.messages); return responses[idx++]; };
    const generateImage = vi.fn(async () => ({
      base64: Buffer.from(renderedPng).toString("base64"),
      mimeType: "image/png",
      effortUsed: "standard" as const,
      aspectUsed: "landscape" as const,
    }));
    const provider = {
      providerId: "mock",
      chat: vi.fn(capture),
      stream: vi.fn(capture),
      healthCheck: vi.fn(async () => ({ ok: true })),
      getCapabilities: () => ({ imageGeneration: true, thinking: false, tools: true, streaming: true, caching: false }),
      generateImage,
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(), sessionState: mockSessionState(),
      fileIO: binaryFileIO(store), callbacks, model: "claude-haiku-4-5-20251001",
    });

    // Turn 1: DM fires update_portrait; the render runs in the background.
    await engine.processInput("Aldric", "I step into the dark.");
    await engine.awaitPendingPortraitRenders();

    // Versioning: the new portrait is the current pointer; the prior one is archived.
    expect([...store.get(portraitPath)!]).toEqual([...renderedPng]);
    expect(store.has(archivePath)).toBe(true);
    expect(generateImage).toHaveBeenCalledTimes(1);

    // Turn 2: the revised portrait rides into THIS turn's user message as an
    // image_input part — the DM sees its actual work, for free.
    await engine.processInput("Aldric", "I keep moving.");
    const turn2 = capturedMessages[capturedMessages.length - 1];
    const lastUser = [...turn2].reverse().find((m) => m.role === "user")!;
    expect(Array.isArray(lastUser.content)).toBe(true);
    const parts = lastUser.content as { type: string; mimeType?: string; label?: string; text?: string }[];
    expect(parts.find((p) => p.type === "image_input")).toMatchObject({ type: "image_input", mimeType: "image/webp", label: "Aldric" });
    // The marker is present and sanitized — single line, no raw quote that could
    // break the pseudo-XML frame.
    const marker = parts.find((p) => p.type === "text" && /portrait_updated/.test(p.text ?? ""))!;
    expect(marker).toBeDefined();
    expect(marker.text).not.toContain("\n"); // newline collapsed
    expect(marker.text).toContain("left boot torn off");
    expect(marker.text).toContain("bare foot muddy"); // inner quotes stripped, not the tag's own
  });

  it("update_portrait serializes concurrent revisions so archived history isn't clobbered", async () => {
    const paths = campaignPaths("/tmp/test-campaign");
    const portraitPath = norm(paths.characterPortrait("Aldric"));
    const store = new Map<string, Uint8Array>();
    store.set(portraitPath, await pngBytes(64, { r: 0, g: 0, b: 0 }));
    // Two renders, distinct bytes; a small delay so both are in flight at once.
    const outs = [await pngBytes(80, { r: 200, g: 0, b: 0 }), await pngBytes(80, { r: 0, g: 0, b: 200 })];
    let call = 0;
    const generateImage = vi.fn(async () => {
      const i = call++;
      await new Promise((r) => setTimeout(r, 3));
      return { base64: Buffer.from(outs[i]).toString("base64"), mimeType: "image/png" as const, effortUsed: "standard" as const, aspectUsed: "landscape" as const };
    });
    // Two update_portrait tool calls in ONE turn → dispatched concurrently.
    const responses: ChatResult[] = [
      {
        text: "",
        toolCalls: [
          { id: "t1", name: "update_portrait", input: { character: "Aldric", change: "boot lost" } },
          { id: "t2", name: "update_portrait", input: { character: "Aldric", change: "scarf added" } },
        ],
        usage: mockUsage(),
        stopReason: "tool_use",
        assistantContent: [
          { type: "tool_use", id: "t1", name: "update_portrait", input: { character: "Aldric", change: "boot lost" } },
          { type: "tool_use", id: "t2", name: "update_portrait", input: { character: "Aldric", change: "scarf added" } },
        ],
      },
      textMessage("Both changes settle."),
    ];
    let idx = 0;
    const provider = {
      providerId: "mock",
      chat: vi.fn(async () => responses[idx++]),
      stream: vi.fn(async () => responses[idx++]),
      healthCheck: vi.fn(async () => ({ ok: true })),
      getCapabilities: () => ({ imageGeneration: true, thinking: false, tools: true, streaming: true, caching: false }),
      generateImage,
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(), sessionState: mockSessionState(),
      fileIO: binaryFileIO(store), callbacks, model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Two things happen at once.");
    await engine.awaitPendingPortraitRenders();

    // Both revisions archived to DISTINCT versions — neither overwrote the other.
    const v1 = store.get(norm(paths.characterPortraitArchive("Aldric", 1)));
    const v2 = store.get(norm(paths.characterPortraitArchive("Aldric", 2)));
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    expect([...v1!]).not.toEqual([...v2!]);
  });

  it("update_portrait errors before rendering when persistence is unavailable", async () => {
    const generateImage = vi.fn(async () => ({ base64: "AAA=", mimeType: "image/png" as const, effortUsed: "standard" as const, aspectUsed: "landscape" as const }));
    const responses: ChatResult[] = [
      {
        text: "",
        toolCalls: [{ id: "t1", name: "update_portrait", input: { character: "Aldric", change: "new hat" } }],
        usage: mockUsage(),
        stopReason: "tool_use",
        assistantContent: [{ type: "tool_use", id: "t1", name: "update_portrait", input: { character: "Aldric", change: "new hat" } }],
      },
      textMessage("Nothing persists."),
    ];
    let idx = 0;
    const provider = {
      providerId: "mock",
      chat: vi.fn(async () => responses[idx++]),
      stream: vi.fn(async () => responses[idx++]),
      healthCheck: vi.fn(async () => ({ ok: true })),
      getCapabilities: () => ({ imageGeneration: true, thinking: false, tools: true, streaming: true, caching: false }),
      generateImage,
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(), sessionState: mockSessionState(),
      fileIO: mockFileIO(), // no writeBinaryFile
      callbacks, model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Change something.");
    await engine.awaitPendingPortraitRenders();

    // Guarded before spending a paid render we couldn't persist.
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("update_portrait with no existing portrait errors and renders nothing", async () => {
    const generateImage = vi.fn(async () => ({ base64: "AAA=", mimeType: "image/png", effortUsed: "standard" as const, aspectUsed: "landscape" as const }));
    const provider = {
      providerId: "mock",
      chat: vi.fn(async () => responses[idx++]),
      stream: vi.fn(async () => responses[idx++]),
      healthCheck: vi.fn(async () => ({ ok: true })),
      getCapabilities: () => ({ imageGeneration: true, thinking: false, tools: true, streaming: true, caching: false }),
      generateImage,
    } as unknown as LLMProvider;
    const responses: ChatResult[] = [
      {
        text: "",
        toolCalls: [{ id: "t1", name: "update_portrait", input: { character: "Nemo", change: "new hat" } }],
        usage: mockUsage(),
        stopReason: "tool_use",
        assistantContent: [{ type: "tool_use", id: "t1", name: "update_portrait", input: { character: "Nemo", change: "new hat" } }],
      },
      textMessage("Nothing visibly changes."),
    ];
    let idx = 0;

    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(), sessionState: mockSessionState(),
      fileIO: { ...mockFileIO(), readBinaryFile: vi.fn(async () => { throw new Error("ENOENT"); }), writeBinaryFile: vi.fn(async () => {}) },
      callbacks, model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Look at Nemo.");
    await engine.awaitPendingPortraitRenders();

    // No portrait on disk for "Nemo" → the tool errored before rendering.
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("tracks session usage", async () => {
    const provider = mockProvider([textMessage("Hello.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Hi.");

    const usage = engine.getSessionUsage();
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(log.usageUpdates.length).toBeGreaterThan(0);
  });

  it("appends to scene transcript", async () => {
    const provider = mockProvider([textMessage("The tavern is warm.")]);
    const { callbacks } = mockCallbacks();
    const scene = mockScene();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene,
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I look around.");

    expect(scene.transcript).toHaveLength(2);
    expect(scene.transcript[0]).toContain("[Aldric]");
    expect(scene.transcript[1]).toContain("DM:");
  });

  it("threads tool messages through addExchange", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("roll_dice", { expression: "1d20" }, "You rolled a 15!"),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I attack the goblin.");

    // Verify tool was invoked and narrative completed
    expect(log.toolStarts.length).toBeGreaterThanOrEqual(1);
    expect(log.toolStarts[0]).toBe("roll_dice");

    expect(log.narrativeComplete.length).toBe(1);
    expect(log.narrativeComplete[0]).toBe("You rolled a 15!");
  });

  it("emits a nested span tree (turn → agent → api_call + tool) for an instrumented turn", async () => {
    // End-to-end check that the real processInput → runProviderLoop →
    // dispatchToolCall path emits correctly-correlated spans (not just the
    // trace.ts primitive in isolation). A tool round + a text round → ≥2
    // api_call spans and one tool span, all under one agent under one turn.
    const spans: SpanRecord[] = [];
    resetTraceLog();
    setTraceSink((r) => spans.push(r));
    try {
      const provider = mockProvider([
        ...toolAndTextMessages("roll_dice", { expression: "1d20" }, "You rolled a 15!"),
      ]);
      const { callbacks } = mockCallbacks();
      const engine = makeEngine({
        provider,
        gameState: mockState(),
        scene: mockScene(),
        sessionState: mockSessionState(),
        fileIO: mockFileIO(),
        callbacks,
        model: "claude-haiku-4-5-20251001",
      });
      await engine.processInput("Aldric", "I attack the goblin.");
    } finally {
      setTraceSink(null);
    }

    const turn = spans.find((s) => s.kind === "turn");
    expect(turn).toBeDefined();
    const agent = spans.find((s) => s.kind === "agent" && s.parentId === turn!.id);
    const tool = spans.find((s) => s.kind === "tool" && s.name === "roll_dice");
    const apiCalls = spans.filter((s) => s.kind === "api_call");

    expect(agent).toBeDefined();
    expect(tool).toBeDefined();
    expect(apiCalls.length).toBeGreaterThanOrEqual(2);

    // Tree shape: turn(root) → agent → { api_call×, tool }
    expect(turn!.parentId).toBeNull();
    expect(tool!.parentId).toBe(agent!.id);
    for (const a of apiCalls) expect(a.parentId).toBe(agent!.id);
    // Everything shares the turn's turnId and the campaign slug.
    for (const s of [agent!, tool!, ...apiCalls]) {
      expect(s.turnId).toBe(turn!.id);
      expect(s.campaignId).toBe("test-campaign");
    }
    // Turn header attributes for the timeline.
    expect(typeof turn!.attrs?.turnNumber).toBe("number");
    expect(turn!.attrs?.participant).toBe("Aldric");
  });

  it("handles errors gracefully", async () => {
    const errorProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => { throw new Error("API down"); }),
      stream: vi.fn(async () => { throw new Error("API down"); }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider: errorProvider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Hello");

    expect(log.errors.length).toBeGreaterThanOrEqual(1);
    expect(log.errors.some((e) => e.message.includes("API down"))).toBe(true);
    expect(engine.getState()).toBe("waiting_input");
  });

  it("transitions scenes", async () => {
    // Scene summarizer response
    const provider = mockProvider([textMessage("- Party met in tavern")]);
    const { callbacks, log } = mockCallbacks();
    const scene = mockScene();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene,
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.transitionScene("Tavern Meeting", 60);

    expect(log.states).toContain("scene_transition");
    expect(scene.sceneNumber).toBe(2);
    expect(engine.getState()).toBe("waiting_input");
  });

  it("refreshes context after scene transition", async () => {
    const provider = mockProvider([textMessage("- Party met in tavern\n---MINI---\nParty met in tavern.")]);
    const { callbacks } = mockCallbacks();
    const fileIO = mockFileIO();
    const state = mockState();

    const sessionState = mockSessionState();
    const engine = makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState,
      fileIO,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.transitionScene("Tavern Meeting", 60);

    // After transition, campaign log.json should have been written and re-read by contextRefresh
    expect(fileIO.readFile).toHaveBeenCalled();
    const readCalls = (fileIO.readFile as ReturnType<typeof vi.fn>).mock.calls
      .map(([p]: unknown[]) => norm(p as string));
    expect(readCalls.some((p: string) => p.includes("log.json"))).toBe(true);

    // The session state should have the updated campaign summary (rendered from JSON)
    expect(sessionState.campaignSummary).toContain("Party met in tavern");
  });

  it("refreshes context after resumePendingTransition", async () => {
    const provider = mockProvider([textMessage("- Resumed summary\n---MINI---\nResumed summary.")]);
    const { callbacks } = mockCallbacks();
    const fileIO = mockFileIO();
    const state = mockState();

    const sessionState = mockSessionState();
    const engine = makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState,
      fileIO,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.resumePendingTransition({
      type: "scene_transition",
      step: "subagent_updates" as import("./scene-manager.js").PendingStep,
      sceneNumber: 1,
      title: "Resume Test",
    });

    // contextRefresh should have re-read the campaign log.json
    const readCalls = (fileIO.readFile as ReturnType<typeof vi.fn>).mock.calls
      .map(([p]: unknown[]) => norm(p as string));
    expect(readCalls.some((p: string) => p.includes("log.json"))).toBe(true);
  });

  it("ends session", async () => {
    const provider = mockProvider([textMessage("- Session summary")]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.endSession("End of adventure");

    expect(log.states).toContain("session_ending");
    expect(engine.getState()).toBe("idle");
  });

  it("ignores input while already processing", async () => {
    // This test verifies the guard against double-processing
    const provider = mockProvider([textMessage("Response 1")]);
    const { callbacks } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Process two inputs — second should be ignored since first isn't done
    const p1 = engine.processInput("Aldric", "First");
    // Immediately try second (engine is in dm_thinking state)
    const p2 = engine.processInput("Aldric", "Second");

    await Promise.all([p1, p2]);

    // Only one API call should have been made
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("intercepts scene_transition TUI command and calls transitionScene", async () => {
    // DM calls scene_transition tool → returns TUI command JSON → engine intercepts
    const provider = mockProvider([
      ...toolAndTextMessages("scene_transition", { title: "The Dark Forest" }, "You enter the forest."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "We head into the forest.");

    // The scene_transition should NOT be forwarded to TUI
    expect(log.tuiCommands.filter((c) => c.type === "scene_transition")).toHaveLength(0);
    // Engine should have gone through scene_transition state
    expect(log.states).toContain("scene_transition");
  });

  it("intercepts session_end TUI command and calls endSession", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("session_end", { title: "End of Session 1" }, "That's all for today."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Let's wrap up.");

    expect(log.tuiCommands.filter((c) => c.type === "session_end")).toHaveLength(0);
    expect(log.states).toContain("session_ending");
  });

});

describe("GameEngine Scribe Integration", () => {
  it("scribe tool spawns subagent and logs summary", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("scribe", {
        updates: [
          { visibility: "private", content: "Grimjaw is a scarred orc chieftain" },
        ],
      }, "You see a scarred orc."),
    ]);
    const { callbacks, log } = mockCallbacks();
    const fio = mockFileIO();
    const devLogs: string[] = [];
    callbacks.onDevLog = (msg) => devLogs.push(msg);

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: fio,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I look at the orc.");
    // The scribe runs detached now — settle it before asserting its effects.
    await engine.settleDeferredWork();

    // Should NOT forward scribe command to TUI
    expect(log.tuiCommands.filter((c) => c.type === "scribe")).toHaveLength(0);
    // runScribe should have been called
    expect(runScribe).toHaveBeenCalled();
    // Dev log should show scribe summary
    expect(devLogs.some((d) => d.includes("scribe"))).toBe(true);
  });

  it("scribe notifies scene manager about created entities", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("scribe", {
        updates: [
          { visibility: "private", content: "Grimjaw is a scarred orc" },
        ],
      }, "You see an orc."),
    ]);
    const { callbacks } = mockCallbacks();
    const fio = mockFileIO();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: fio,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I look around.");
    // The scribe runs detached now — settle it before asserting its effects.
    await engine.settleDeferredWork();

    // The mock runScribe returns entityDeltas with grimjaw
    // Mid-scene upserts update the in-memory tree but not the DM snapshot
    const sm = engine.getSceneManager();
    expect(sm.getEntityTree()["grimjaw"]).toBeDefined();
    expect(sm.getEntityTree()["grimjaw"].name).toBe("Grimjaw");
  });

  it("runs scribes detached + serialized, flushed by settleDeferredWork, and nudges the sheet cache", async () => {
    const { callbacks, log } = mockCallbacks();
    const engine = makeEngine({
      provider: mockProvider([]),
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const order: string[] = [];
    // Gate the first scribe so we can observe it running in the background while
    // the turn (here: applyDeferredTuiCommands) has already returned.
    let release1!: () => void;
    const gate1 = new Promise<void>((r) => { release1 = r; });
    vi.mocked(runScribe)
      .mockImplementationOnce(async () => {
        order.push("scribe1:start");
        await gate1;
        order.push("scribe1:end");
        return { summary: "", created: ["a"], updated: [], removedSlugs: [], usage: zero,
          entityDeltas: [{ slug: "a", name: "A", aliases: [], type: "character", path: "characters/a.md" }] };
      })
      .mockImplementationOnce(async () => {
        order.push("scribe2:start");
        // A location-only write must NOT nudge the character pane (gating).
        return { summary: "", created: ["loc"], updated: [], removedSlugs: [], usage: zero,
          entityDeltas: [{ slug: "loc", name: "Loc", aliases: [], type: "location", path: "locations/loc/index.md" }] };
      });

    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    // Two deferred scribe batches back-to-back. Neither call blocks on the
    // gated subagent — if the scribe were still awaited inline, the first
    // `await` here would deadlock (gate1 is held).
    await engine.applyDeferredTuiCommands([{ type: "scribe", updates: [{ visibility: "private", content: "first" }] }]);
    await engine.applyDeferredTuiCommands([{ type: "scribe", updates: [{ visibility: "private", content: "second" }] }]);

    // Detached + serialized: scribe1 is running (gated), scribe2 has NOT started.
    await tick();
    expect(order).toEqual(["scribe1:start"]);

    // The barrier resolves only once the whole chain drains, in order.
    release1();
    await engine.settleDeferredWork();
    expect(order).toEqual(["scribe1:start", "scribe1:end", "scribe2:start"]);

    // Effects landed: both tree deltas applied; the sheet-cache nudge fired
    // exactly once — for the character write (scribe1), NOT the location-only
    // write (scribe2).
    expect(engine.getSceneManager().getEntityTree()["a"]).toBeDefined();
    expect(engine.getSceneManager().getEntityTree()["loc"]).toBeDefined();
    expect(log.tuiCommands.filter((c) => c.type === "character_sheet_changed").length).toBe(1);
  });

  it("runs the scene-tracker detached on its own lane; the write-back is flushed by settleDeferredWork", async () => {
    // Seed three prior player exchanges so the cadence (every 4) fires this turn.
    const scene = mockScene();
    scene.transcript = ["**[Aldric]** a", "**[Aldric]** b", "**[Aldric]** c"];

    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider: mockProvider([textMessage("You wait in the dark.")]),
      gameState: mockState(),
      scene,
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    const sm = engine.getSceneManager();
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = false;
    // Gate the tracker and have it write back open threads, exactly as the real
    // one mutates the scene — so we can watch when the write-back becomes visible.
    vi.spyOn(sm, "runSceneTracker").mockImplementation(async () => {
      started = true;
      await gate;
      sm.getScene().openThreads = "the door is ajar";
      return zero;
    });

    await engine.processInput("Aldric", "I wait.");

    // Detached: the turn returned even though the tracker is gated — an inline
    // await would deadlock. It is running in the background but its write-back
    // has not landed, so the scene still shows the stale (empty) threads.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(started).toBe(true);
    expect(sm.getScene().openThreads).toBe("");

    // The barrier flushes the lane; the refreshed threads are now visible. This
    // is the freshness guarantee the next turn's getSystemPrompt relies on.
    release();
    await engine.settleDeferredWork();
    expect(sm.getScene().openThreads).toBe("the door is ajar");
  });
});

describe("GameEngine Git Auto-Commit", () => {
  function mockGitIO() {
    return {
      init: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
      commit: vi.fn(async () => "abc123"),
      log: vi.fn(async () => []),
      checkout: vi.fn(async () => {}),
      resetTo: vi.fn(async () => {}),
      pruneUnreachable: vi.fn(async () => 0),
      // head=1, workdir=2, stage=2: file is staged and differs from HEAD → commit will fire
      statusMatrix: vi.fn(async () => [["file.md", 1, 2, 2] as [string, number, number, number]]),
      listFiles: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    };
  }

  it("auto-commits after N exchanges when git enabled", async () => {
    const gitIO = mockGitIO();
    const state = mockState();
    state.config.recovery.enable_git = true;
    state.config.recovery.auto_commit_interval = 2;

    // Need 2 responses (one per processInput call)
    const provider = mockProvider([
      textMessage("Response 1."),
      textMessage("Response 2."),
    ]);
    const { callbacks } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
      gitIO,
    });

    // First exchange — triggers lazy init commit only (1 < 2 interval)
    await engine.processInput("Aldric", "First action.");
    expect(gitIO.commit).toHaveBeenCalledTimes(1); // init commit
    expect(gitIO.commit).toHaveBeenCalledWith(
      expect.anything(), "auto: initial state", expect.anything(),
    );

    // Second exchange — should trigger auto-commit (2 >= 2)
    await engine.processInput("Aldric", "Second action.");
    expect(gitIO.commit).toHaveBeenCalledTimes(2); // init + auto
  });

  it("no git errors when gitIO not provided", async () => {
    const provider = mockProvider([textMessage("Response.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
      // No gitIO — default behavior
    });

    await engine.processInput("Aldric", "Hello.");
    expect(log.errors).toHaveLength(0);
    expect(engine.getRepo()).toBeNull();
  });

  it("exposes repo via getRepo()", () => {
    const gitIO = mockGitIO();
    const state = mockState();
    state.config.recovery.enable_git = true;

    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider: mockProvider([]),
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
      gitIO,
    });

    expect(engine.getRepo()).not.toBeNull();
    expect(engine.getRepo()!.isEnabled()).toBe(true);
  });
});

describe("GameEngine AI Auto-Turn", () => {
  beforeEach(() => {
    vi.mocked(aiPlayerTurn).mockClear();
  });

  function mockStateWithAI(): GameState {
    return {
      maps: {},
      clocks: createClocksState(),
      combat: createCombatState(),
      combatConfig: createDefaultConfig(),
      decks: createDecksState(),
      objectives: createObjectivesState(),
      config: {
        name: "Test",
        dm_personality: { name: "grim", prompt_fragment: "Be terse." },
        players: [
          { name: "Alice", character: "Aldric", type: "human" },
          { name: "Bot", character: "Zara", type: "ai" },
        ],
        combat: createDefaultConfig(),
        context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
        recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
        choices: { campaign_default: "never", player_overrides: {} },
      },
      campaignRoot: "/tmp/test-campaign",
      homeDir: "/tmp/home",
      activePlayerIndex: 0,
      displayResources: {},
      resourceValues: {},
    };
  }

  it("triggers AI turn when active player is AI after processInput", async () => {
    vi.useFakeTimers();

    const state = mockStateWithAI();
    // Set active player to the AI player
    state.activePlayerIndex = 1;

    // Two responses: first for the initial processInput, second for the AI-triggered processInput
    const provider = mockProvider([
      textMessage("The goblin attacks!"),
      textMessage("Zara swings her sword."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Force engine to waiting_input so processInput works
    // Process a human input first (pretend active player switches to AI after DM responds)
    state.activePlayerIndex = 0;
    await engine.processInput("Aldric", "I look around.");

    // Now switch to AI player — the processAITurnIfNeeded at end of processInput won't fire
    // because at that point activePlayerIndex is 0 (human). Let's test directly.
    state.activePlayerIndex = 1;
    engine.processAITurnIfNeeded();

    // Flush the setTimeout(0)
    await vi.advanceTimersByTimeAsync(0);

    expect(aiPlayerTurn).toHaveBeenCalled();
    expect(log.turnStarts).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "ai", participant: "Zara" })])
    );

    vi.useRealTimers();
  });

  it("safety valve stops at MAX_AI_CHAIN consecutive AI turns", async () => {
    const state = mockStateWithAI();
    state.activePlayerIndex = 1; // AI player

    const provider = mockProvider([textMessage("Response.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Simulate having hit the chain limit
    // Access the depth via executeAITurn calls
    for (let i = 0; i < 10; i++) {
      // Manually bump depth by calling executeAITurn with a state that's always AI
      // But we'll get infinite recursion... Instead, test via the method directly
    }

    // Simpler: call executeAITurn 11 times rapidly to test the guard
    // The chain limit is checked inside executeAITurn
    // Let's set up the mock to not chain (by switching to human after the call)
    vi.mocked(aiPlayerTurn).mockImplementation(async () => {
      // Keep activePlayerIndex on AI so isAITurn keeps returning true
      // But processInput will be called with fromAI: true, not resetting depth
      return {
        text: "I attack!",
        action: "I attack!",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    });

    // Directly call executeAITurn repeatedly to hit the limit
    // After 10 calls, the 11th should be rejected
    for (let i = 0; i < 11; i++) {
      // Switch back to waiting state so processInput doesn't skip
      await engine.executeAITurn();
    }

    expect(log.narrativeDeltas).toEqual(
      expect.arrayContaining([expect.stringContaining("[AI turn limit reached]")])
    );
  });

  it("human input resets AI chain depth", async () => {
    const state = mockStateWithAI();
    state.activePlayerIndex = 0; // human player

    const provider = mockProvider([
      textMessage("Response 1."),
      textMessage("Response 2."),
    ]);
    const { callbacks } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Human input without fromAI resets depth
    await engine.processInput("Aldric", "Hello");
    // The depth should be 0 now (human input resets it)
    // Verify by checking that a subsequent AI turn would work
    // (implicitly tested — if depth weren't reset, chaining wouldn't work)
    expect(engine.getState()).toBe("waiting_input");
  });

  it("character sheet loading failure falls back gracefully", async () => {
    vi.useFakeTimers();

    const state = mockStateWithAI();
    state.activePlayerIndex = 1; // AI player

    const fio = mockFileIO();
    vi.mocked(fio.readFile).mockRejectedValue(new Error("ENOENT"));

    const provider = mockProvider([textMessage("DM responds.")]);
    const { callbacks } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: fio,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Call executeAITurn directly
    await engine.executeAITurn();

    // Should still call aiPlayerTurn despite file read failure
    expect(aiPlayerTurn).toHaveBeenCalled();
    const callArgs = vi.mocked(aiPlayerTurn).mock.calls[0][1];
    expect(callArgs.characterSheet).toBe("Character: Zara");

    vi.useRealTimers();
  });

  it("AI turn accumulates usage stats", async () => {
    vi.useFakeTimers();

    const state = mockStateWithAI();
    state.activePlayerIndex = 1;

    vi.mocked(aiPlayerTurn).mockResolvedValue({
      text: "I attack!",
      action: "I attack!",
      usage: { inputTokens: 75, outputTokens: 25, cacheReadTokens: 10, cacheCreationTokens: 0 },
    });

    const provider = mockProvider([textMessage("The goblin falls!")]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.executeAITurn();

    // Usage should include both the AI subagent and the DM response
    const usage = engine.getSessionUsage();
    // AI subagent: 75 input + DM response: 100 input = 175
    expect(usage.inputTokens).toBeGreaterThanOrEqual(75);
    expect(log.usageUpdates.length).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });
});

describe("GameEngine Behavioral Reminder", () => {
  /** Extract the messages array from the Nth stream() call (0-indexed). */
  function sentMessages(prov: LLMProvider, callIdx: number): { role: string; content: string | unknown[] }[] {
    const streamFn = prov.stream as ReturnType<typeof vi.fn>;
    return (streamFn.mock.calls[callIdx][0] as { messages: { role: string; content: string | unknown[] }[] }).messages;
  }

  it("no reminder injected during first 3 turns even without tools or entity formatting", async () => {
    const provider = mockProvider([
      textMessage("Turn 1."),
      textMessage("Turn 2."),
      textMessage("Turn 3."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");

    for (let i = 0; i < 3; i++) {
      const msgs = sentMessages(provider, i);
      expect(msgs.every((m) => typeof m.content !== "string" || !m.content.includes("[dm-note]"))).toBe(true);
    }
  });

  it("injects tool reminder on 4th turn after 3 turns without tools", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      textMessage("Four."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "Four.");

    const msgs = sentMessages(provider, 3);
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    expect(dmNote).toBeDefined();
    expect(dmNote!.content).toContain("use your tools");
  });

  it("tool use resets the tool counter and suppresses the tool reminder", async () => {
    // Turn 4 uses a non-TUI tool → 2 stream calls (one per agent loop round).
    // So turn 5 lands at stream-call index 5, not 4.
    const provider = mockProvider([
      textMessage("One."),            // turn 1 → stream[0]
      textMessage("Two."),            // turn 2 → stream[1]
      textMessage("Three."),          // turn 3 → stream[2]
      ...toolAndTextMessages("roll_dice", { expression: "1d20" }, "You roll a 14."), // turn 4 → stream[3,4]
      textMessage("Five."),           // turn 5 → stream[5]
    ]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "Four."); // tool used here → turnsWithoutTools resets to 0
    await engine.processInput("Aldric", "Five.");

    // After the tool turn (counter reset to 0), only 1 turn has passed without tools.
    // Tool reminder should be absent; entity reminder may appear independently.
    const msgs = sentMessages(provider, 5);
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    expect(dmNote?.content ?? "").not.toContain("use your tools");
  });

  it("injects entity reminder after 3 turns without color-coded entities", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      textMessage("Four."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "Four.");

    const msgs = sentMessages(provider, 3);
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    expect(dmNote).toBeDefined();
    expect(dmNote!.content).toContain("color-code entity names");
  });

  it("color-coded entity in DM response resets the entity counter", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      // Turn 3 — response contains a color-coded entity
      textMessage('You see <color=#cc8844>Grimjaw</color> approach.'),
      textMessage("Four."),
      textMessage("Five."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three."); // color-coded entity in response
    await engine.processInput("Aldric", "Four.");
    await engine.processInput("Aldric", "Five.");

    // After the color-coded entity on turn 3, the counter resets.
    // Turn 4 is only 1 turn after the reset, so no entity reminder on turn 5 (index 4).
    const msgs = sentMessages(provider, 4);
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    expect(dmNote?.content ?? "").not.toContain("color-code entity names");
  });

  it("reminder is skipped for skipTranscript turns (session open/resume)", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      // skipTranscript turn on what would be turn 4
      textMessage("Session resumed."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "[session-open]", { skipTranscript: true });

    const msgs = sentMessages(provider, 3);
    expect(msgs.every((m) => typeof m.content !== "string" || !m.content.includes("[dm-note]"))).toBe(true);
  });

  it("emits devLog when behavioral reminder is injected", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      textMessage("Four."),
    ]);
    const { callbacks, log } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "Four.");

    expect(log.devLogs.some((m) => m.includes("[dm-note]"))).toBe(true);
  });
});

describe("GameEngine Turn Lifecycle", () => {
  beforeEach(() => {
    vi.mocked(aiPlayerTurn).mockClear();
    vi.mocked(aiPlayerTurn).mockResolvedValue({
      text: "I attack the goblin.",
      action: "I attack the goblin.",
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
  });

  it("fires player turn, then DM turn with onNarrativeComplete inside", async () => {
    const provider = mockProvider([textMessage("The door opens.")]);
    const { callbacks } = mockCallbacks();
    const events: string[] = [];

    // Wrap callbacks to track ordering
    const origOnTurnStart = callbacks.onTurnStart;
    callbacks.onTurnStart = (turn) => { events.push(`turnStart:${turn.role}`); origOnTurnStart(turn); };
    const origComplete = callbacks.onNarrativeComplete;
    callbacks.onNarrativeComplete = (text) => { events.push("complete"); origComplete(text); };
    const origEnd = callbacks.onTurnEnd;
    callbacks.onTurnEnd = (turn) => { events.push(`turnEnd:${turn.role}`); origEnd(turn); };

    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I open the door.");

    expect(events).toEqual([
      "turnStart:player",
      "turnEnd:player",
      "turnStart:dm",
      "complete",
      "turnEnd:dm",
    ]);
  });

  it("turnNumber increments across calls (player + DM per input)", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");

    // Each processInput fires player turn + DM turn = 4 total starts
    expect(log.turnStarts).toHaveLength(4);
    expect(log.turnStarts[0]).toMatchObject({ turnNumber: 1, role: "player" });
    expect(log.turnStarts[1]).toMatchObject({ turnNumber: 2, role: "dm" });
    expect(log.turnStarts[2]).toMatchObject({ turnNumber: 3, role: "player" });
    expect(log.turnStarts[3]).toMatchObject({ turnNumber: 4, role: "dm" });
  });

  it("human input fires player+dm roles; fromAI fires only dm role", async () => {
    const provider = mockProvider([
      textMessage("Response to human."),
      textMessage("Response to AI."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Human turn — fires player + dm
    await engine.processInput("Aldric", "Hello.");
    expect(log.turnStarts[0]).toMatchObject({ role: "player", participant: "Aldric" });
    expect(log.turnStarts[1]).toMatchObject({ role: "dm", participant: "DM" });

    // AI turn (via fromAI flag) — fires only dm (AI turn was emitted by executeAITurn)
    await engine.processInput("Zara", "I attack!", { fromAI: true });
    expect(log.turnStarts).toHaveLength(3);
    expect(log.turnStarts[2]).toMatchObject({ role: "dm", participant: "DM" });
  });

  it("fires AI turn via onTurnStart/onTurnEnd in executeAITurn", async () => {
    vi.useFakeTimers();
    vi.mocked(aiPlayerTurn).mockClear();

    const state = {
      maps: {},
      clocks: createClocksState(),
      combat: createCombatState(),
      combatConfig: createDefaultConfig(),
      decks: createDecksState(),
      objectives: createObjectivesState(),
      config: {
        name: "Test",
        dm_personality: { name: "grim", prompt_fragment: "Be terse." },
        players: [
          { name: "Alice", character: "Aldric", type: "human" },
          { name: "Bot", character: "Zara", type: "ai" },
        ],
        combat: createDefaultConfig(),
        context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
        recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
        choices: { campaign_default: "never", player_overrides: {} },
      },
      campaignRoot: "/tmp/test-campaign",
      homeDir: "/tmp/home",
      activePlayerIndex: 1,
      displayResources: {},
      resourceValues: {},
    } satisfies GameState;

    const provider = mockProvider([textMessage("DM responds to AI.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider, gameState: state, scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.executeAITurn();

    // Should fire AI turn (DM turn skipped because executeAITurn sets
    // state to dm_thinking before calling processInput, which returns early)
    const aiStarts = log.turnStarts.filter((t) => t.role === "ai");
    expect(aiStarts).toHaveLength(1);
    expect(aiStarts[0].participant).toBe("Zara");
    expect(aiStarts[0].text).toBe("I attack the goblin.");

    const aiEnds = log.turnEnds.filter((t) => t.role === "ai");
    expect(aiEnds).toHaveLength(1);

    // Should NOT have emitted a raw narrative delta for the AI action
    expect(log.narrativeDeltas.every((d) => !d.includes("Zara (AI)"))).toBe(true);

    vi.useRealTimers();
  });

  it("behavioral counters only increment on human turns", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      textMessage("AI Response."), // fromAI turn — should NOT increment counters
      textMessage("Four."),
    ]);
    const { callbacks } = mockCallbacks();

    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");

    // AI turn should NOT increment the counter
    await engine.processInput("Zara", "AI does stuff.", { fromAI: true });

    // Fourth human turn — counter should be at 3 (not 4)
    // If AI turn had counted, this would be turn 5 and would trigger reminder
    await engine.processInput("Aldric", "Four.");

    // Extract messages from the 5th stream call (index 4)
    const streamFn = provider.stream as ReturnType<typeof vi.fn>;
    const msgs = (streamFn.mock.calls[4][0] as { messages: { role: string; content: string | unknown[] }[] }).messages;
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    // Should have the reminder because human turns 1-3 are toolless, then AI doesn't count,
    // then human turn 4 — conversation.size is now ≥3 and turnsWithoutTools is 3+
    expect(dmNote).toBeDefined();
    expect(dmNote!.content).toContain("use your tools");
  });
});

describe("pruneEmptyDirs", () => {
  it("removes empty directories under campaign subdirs", async () => {
    const io = mockFileIO();
    const rmdirCalls: string[] = [];
    io.rmdir = vi.fn(async (path: string) => { rmdirCalls.push(norm(path)); });

    // config.json must exist (safety check)
    files[norm("/tmp/campaign/config.json")] = "{}";
    dirs.add(norm("/tmp/campaign/campaign/scenes"));
    dirs.add(norm("/tmp/campaign/campaign/scenes/002-tavern"));

    // First listDir: scenes has one empty subdir
    (io.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p.endsWith("campaign/scenes")) return ["002-tavern"];
      if (p.endsWith("002-tavern")) return []; // empty!
      return [];
    });

    const removed = await pruneEmptyDirs("/tmp/campaign", io);
    expect(removed).toBe(1);
    expect(rmdirCalls[0]).toContain("002-tavern");
  });

  it("does nothing when config.json is missing (safety guard)", async () => {
    const io = mockFileIO();
    io.rmdir = vi.fn(async () => {});
    // No config.json — not a campaign root
    dirs.add(norm("/tmp/not-campaign/campaign/scenes"));

    const removed = await pruneEmptyDirs("/tmp/not-campaign", io);
    expect(removed).toBe(0);
    expect(io.rmdir).not.toHaveBeenCalled();
  });

  it("does not remove non-empty directories", async () => {
    const io = mockFileIO();
    io.rmdir = vi.fn(async () => {});

    files[norm("/tmp/campaign/config.json")] = "{}";
    files[norm("/tmp/campaign/campaign/scenes/001-opening/transcript.md")] = "# Scene 1";
    dirs.add(norm("/tmp/campaign/campaign/scenes"));
    dirs.add(norm("/tmp/campaign/campaign/scenes/001-opening"));

    (io.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p.endsWith("campaign/scenes")) return ["001-opening"];
      if (p.endsWith("001-opening")) return ["transcript.md"];
      return [];
    });

    const removed = await pruneEmptyDirs("/tmp/campaign", io);
    expect(removed).toBe(0);
  });

  it("prunes nested empty directories depth-first", async () => {
    const io = mockFileIO();
    const rmdirCalls: string[] = [];
    io.rmdir = vi.fn(async (path: string) => { rmdirCalls.push(norm(path)); });

    files[norm("/tmp/campaign/config.json")] = "{}";
    dirs.add(norm("/tmp/campaign/locations"));
    dirs.add(norm("/tmp/campaign/locations/old-tavern"));

    let tavernPruned = false;
    (io.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p.endsWith("/locations") && tavernPruned) return [];
      if (p.endsWith("/locations")) return ["old-tavern"];
      if (p.endsWith("old-tavern")) {
        tavernPruned = true;
        return [];
      }
      return [];
    });

    const removed = await pruneEmptyDirs("/tmp/campaign", io);
    // Both old-tavern and locations should be pruned
    expect(removed).toBe(2);
    // old-tavern should be pruned before locations (depth-first)
    expect(rmdirCalls[0]).toContain("old-tavern");
    expect(rmdirCalls[1]).toContain("locations");
  });
});

describe("GameEngine OOC summary injection", () => {
  it("injects OOC summary into player message and persists in conversation history", async () => {
    const streamCalls: unknown[] = [];
    let streamCallIdx = 0;
    const responses = [textMessage("Welcome back."), textMessage("You look around.")];

    const spyProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => textMessage("fallback")),
      stream: vi.fn(async (params: unknown, _onDelta?: unknown) => {
        streamCalls.push(params);
        return responses[streamCallIdx++];
      }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider: spyProvider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Set pending OOC summary (simulating what PlayingPhase does on OOC exit)
    engine.setPendingOOCSummary("Corrected HP from 12 to 18.\nClarified tavern location.");

    // First processInput — should inject the OOC summary
    await engine.processInput("Aldric", "I look around.");
    const firstCall = streamCalls[0] as { messages: { role: string; content: string | unknown[] }[] };
    const userMsgs = firstCall.messages.filter((m) => m.role === "user");
    const lastUserContent = userMsgs[userMsgs.length - 1].content as string;
    expect(lastUserContent).toContain("<ooc_summary>");
    expect(lastUserContent).toContain("Corrected HP from 12 to 18.");
    expect(lastUserContent).toContain("Clarified tavern location.");
    expect(lastUserContent).toContain("</ooc_summary>");
    expect(lastUserContent).toContain("[Aldric] I look around.");

    // Second processInput — OOC summary should be cleared from new input,
    // but the prior stored exchange should still contain it in conversation history
    await engine.processInput("Aldric", "I check the door.");
    const secondCall = streamCalls[1] as { messages: { role: string; content: string | unknown[] }[] };
    const allMsgs = secondCall.messages;
    // The new user message should NOT have OOC summary
    const newUserContent = allMsgs[allMsgs.length - 1].content as string;
    expect(newUserContent).not.toContain("<ooc_summary>");
    // The stored conversation history (prior user message) should still have it.
    // Serialize all prior messages to check the OOC summary persisted.
    const priorMsgsJson = JSON.stringify(allMsgs.slice(0, -1));
    expect(priorMsgsJson).toContain("<ooc_summary>");
  });

  it("does not inject when no OOC summary is pending", async () => {
    const streamCalls: unknown[] = [];

    const spyProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => textMessage("fallback")),
      stream: vi.fn(async (params: unknown, _onDelta?: unknown) => {
        streamCalls.push(params);
        return textMessage("Hello.");
      }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider: spyProvider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I open the door.");
    const call = streamCalls[0] as { messages: { role: string; content: string | unknown[] }[] };
    const userMsgs = call.messages.filter((m) => m.role === "user");
    const content = userMsgs[userMsgs.length - 1].content as string;
    expect(content).not.toContain("<ooc_summary>");
  });
});

describe("GameEngine TUI-only tool round (#266)", () => {
  it("does not bail out on TUI-only rounds — DM gets to continue", async () => {
    // Turn 1: DM responds with text + TUI-only tool call.
    // Previously this would bail out; now tool results are sent back and
    // the DM gets another round to finish its turn.
    const turn1Round1: ChatResult = {
      text: "You enter the tavern.",
      toolCalls: [{ id: "toolu_ml", name: "update_modeline", input: { location: "Tavern" } }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "text", text: "You enter the tavern." },
        { type: "tool_use", id: "toolu_ml", name: "update_modeline", input: { location: "Tavern" } },
      ],
    };

    // Turn 1, round 2: DM finishes its turn
    const turn1Round2 = textMessage("A barkeep polishes a glass.");

    // Turn 2: Normal text response
    const turn2Msg = textMessage("The bartender nods.");

    let streamCallIdx = 0;
    const streamResponses = [turn1Round1, turn1Round2, turn2Msg];
    const streamCalls: unknown[] = [];

    const spyProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => textMessage("fallback")),
      stream: vi.fn(async (params: unknown, _onDelta?: unknown) => {
        streamCalls.push(params);
        return streamResponses[streamCallIdx++];
      }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();

    const engine = makeEngine({
      provider: spyProvider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Turn 1: tool results sent back → 2 API calls (no bail-out)
    await engine.processInput("Aldric", "I enter the tavern.");
    expect(spyProvider.stream).toHaveBeenCalledTimes(2);

    // Turn 2: conversation history should include the tool_use/tool_result
    // pair from turn 1 so the DM sees a coherent exchange.
    await engine.processInput("Aldric", "I talk to the bartender.");
    expect(spyProvider.stream).toHaveBeenCalledTimes(3);

    // Verify the third call's messages include the tool_use + tool_result
    const thirdCallParams = streamCalls[2] as { messages: { role: string; content: string | unknown[] }[] };
    const msgs = thirdCallParams.messages;

    // Find the assistant message with tool_use from turn 1
    const assistantWithTools = msgs.find((m) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      (m.content as { type: string }[]).some((b) => b.type === "tool_use"),
    );
    expect(assistantWithTools).toBeDefined();

    // Find the matching tool_result
    const toolResultMsg = msgs.find((m) =>
      m.role === "user" && Array.isArray(m.content) &&
      (m.content as { type: string }[]).some((b) => b.type === "tool_result"),
    );
    expect(toolResultMsg).toBeDefined();
  });
});

describe("GameEngine resolve_turn routing", () => {
  it("returns error when no combat session is active", async () => {
    // DM calls resolve_turn without start_combat
    const provider = mockProvider([
      ...toolAndTextMessages("resolve_turn", {
        actor: "Kael",
        action: "Attack goblin",
      }, "I'll try something else."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I attack!");

    // The tool should have returned an error
    expect(log.toolEnds).toContain("resolve_turn");
    // But engine should still complete normally
    expect(engine.getState()).toBe("waiting_input");
  });
});

describe("cross-mode resource dispatch: Engine + Dev Mode share singleton", () => {
  it("Dev Mode tool dispatch mutates GameState and forwards TUI command", async () => {
    const fio = mockFileIO();
    const state = mockState();
    const provider = mockProvider([textMessage("ok")]);
    const { callbacks } = mockCallbacks();

    // Construct engine (production code wires callbacks on singleton)
    makeEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: fio,
      callbacks,
    });

    // Simulate Dev Mode dispatching resource tools via the same singleton
    const { buildDevToolHandler } = await import("./subagents/dev-mode.js");
    const onTuiCommand = vi.fn();
    const handler = buildDevToolHandler(state, fio, undefined, undefined, undefined, undefined, onTuiCommand);

    await handler("set_display_resources", { character: "Aldric", resources: ["HP", "MP"] });
    await handler("set_resource_values", { character: "Aldric", values: { HP: "20/30", MP: "5/10" } });

    // TUI command should have been forwarded (triggers React state → persist effect)
    expect(onTuiCommand).toHaveBeenCalledTimes(2);

    // GameState should be mutated (DM prompt reads this)
    expect(state.displayResources["Aldric"]).toEqual(["HP", "MP"]);
    expect(state.resourceValues["Aldric"]).toEqual({ HP: "20/30", MP: "5/10" });

    // Persistence now happens via React useEffect in app.tsx (same pattern as modelines),
    // not via the registry callback. The TUI command triggers setResources → effect → persist.
  });
});

describe("applyResolutionDeltas — system-agnostic hp_change", () => {
  it("uses resource key from delta when present", async () => {
    const state = mockState();
    state.displayResources["Goblin"] = ["Hull Integrity"];
    state.resourceValues["Goblin"] = { "Hull Integrity": "50" };

    const provider = mockProvider([textMessage("ok")]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: state, scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    const applyDeltas = (engine as unknown as { applyResolutionDeltas: (d: unknown[]) => void }).applyResolutionDeltas.bind(engine);
    applyDeltas([{ type: "hp_change", target: "Goblin", details: { resource: "Hull Integrity", amount: -15 } }]);

    expect(state.resourceValues["Goblin"]["Hull Integrity"]).toBe("35");
  });

  it("falls back to first displayResource key when delta has no resource", async () => {
    const state = mockState();
    state.displayResources["Kael"] = ["Vitality", "Mana"];
    state.resourceValues["Kael"] = { Vitality: "100", Mana: "50" };

    const provider = mockProvider([textMessage("ok")]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: state, scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    const applyDeltas = (engine as unknown as { applyResolutionDeltas: (d: unknown[]) => void }).applyResolutionDeltas.bind(engine);
    applyDeltas([{ type: "hp_change", target: "Kael", details: { amount: -20 } }]);

    expect(state.resourceValues["Kael"]["Vitality"]).toBe("80");
    expect(state.resourceValues["Kael"]["Mana"]).toBe("50"); // untouched
  });

  it("falls back to 'hp' when no displayResources and no resource in delta", async () => {
    const state = mockState();
    const provider = mockProvider([textMessage("ok")]);
    const { callbacks } = mockCallbacks();
    const engine = makeEngine({
      provider, gameState: state, scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    const applyDeltas = (engine as unknown as { applyResolutionDeltas: (d: unknown[]) => void }).applyResolutionDeltas.bind(engine);
    applyDeltas([{ type: "hp_change", target: "Goblin", details: { amount: -5 } }]);

    // No displayResources, no resource in delta → falls back to "hp"
    expect(state.resourceValues["Goblin"]["hp"]).toBe("-5");
  });
});

describe("content classifier refusal", () => {
  function refusalMessage(): ChatResult {
    return {
      text: "",
      toolCalls: [],
      usage: mockUsage(),
      stopReason: "refusal",
      assistantContent: [],
    };
  }

  it("fires onRefusal and does not persist exchange", async () => {
    const provider = mockProvider([refusalMessage()]);
    const { callbacks, log } = mockCallbacks();
    let refusalFired = false;
    callbacks.onRefusal = () => { refusalFired = true; };

    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    await engine.processInput("Aldric", "Something problematic");

    expect(refusalFired).toBe(true);
    expect(log.errors).toHaveLength(0);
    expect(engine.hasPendingRetry()).toBe(false);
  });

  it("fires onTurnEnd after refusal", async () => {
    const provider = mockProvider([refusalMessage()]);
    const { callbacks, log } = mockCallbacks();
    callbacks.onRefusal = () => {};

    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    await engine.processInput("Aldric", "Something problematic");

    // DM turn started and ended
    expect(log.turnStarts).toHaveLength(2); // player turn + dm turn
    expect(log.turnEnds).toHaveLength(2);
  });

  it("does not include refusal in narrative completions", async () => {
    const provider = mockProvider([refusalMessage()]);
    const { callbacks, log } = mockCallbacks();
    callbacks.onRefusal = () => {};

    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    await engine.processInput("Aldric", "Something problematic");

    expect(log.narrativeComplete).toHaveLength(0);
  });

  it("still tracks usage on refusal", async () => {
    const provider = mockProvider([refusalMessage()]);
    const { callbacks, log } = mockCallbacks();
    callbacks.onRefusal = () => {};

    const engine = makeEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    await engine.processInput("Aldric", "Something problematic");

    expect(log.usageUpdates).toHaveLength(1);
    expect(log.usageUpdates[0].inputTokens).toBe(100);
    expect(log.usageUpdates[0].outputTokens).toBe(50);
  });

  it("skips promote_character when sheet_status is complete", async () => {
    const charPath = norm("/tmp/test-campaign/characters/storm.md");
    files[charPath] = "# Storm\n\n**Type:** PC\n**Sheet Status:** complete\n\n## Skills\n- Hack (d8)\n";

    const provider = mockProvider([
      ...toolAndTextMessages(
        "promote_character",
        { character: "storm", context: "Build initial sheet" },
        "Storm is ready.",
      ),
    ]);
    const { callbacks, log } = mockCallbacks();
    const io = mockFileIO();

    const engine = makeEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: io,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Look around");

    // promoteCharacter subagent should NOT have been called
    expect(promoteCharacter).not.toHaveBeenCalled();

    // Dev log should say it was skipped
    expect(log.devLogs.some((m) => m.includes("skipped, sheet already complete"))).toBe(true);

    // The sheet_status flag should have been cleared for future level-ups
    const updated = files[charPath];
    expect(updated).not.toContain("Sheet Status");
    // But the sheet content should be preserved
    expect(updated).toContain("## Skills");
  });
});
