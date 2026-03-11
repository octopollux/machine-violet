import { describe, it, expect } from "vitest";
import {
  BehaviorInjection,
  ScenePacingInjection,
  LengthSteeringInjection,
  InjectionRegistry,
} from "./injections.js";
import type {
  InjectionContext,
  ResponseInfo,
  TerminalDims,
} from "./injections.js";
import type { SceneState } from "./scene-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockScene(overrides?: Partial<SceneState>): SceneState {
  return {
    sceneNumber: 1,
    slug: "test-scene",
    transcript: [],
    precis: "",
    openThreads: "",
    npcIntents: "",
    playerReads: "",
    sessionNumber: 1,
    ...overrides,
  };
}

function baseCtx(overrides?: Partial<InjectionContext>): InjectionContext {
  return {
    conversationSize: 0,
    scene: mockScene(),
    skipTranscript: false,
    terminalDims: undefined,
    ...overrides,
  };
}

function dims(cols = 100, rows = 40, narRows = 25): TerminalDims {
  return { columns: cols, rows, narrativeRows: narRows };
}

function responseInfo(overrides?: Partial<ResponseInfo>): ResponseInfo {
  return {
    text: "The tavern is warm.",
    toolUsed: false,
    fromAI: false,
    wrappedLineCount: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BehaviorInjection
// ---------------------------------------------------------------------------

describe("BehaviorInjection", () => {
  it("returns null when conversationSize < threshold", () => {
    const inj = new BehaviorInjection();
    // Pump counters past threshold
    for (let i = 0; i < 5; i++) inj.afterResponse(responseInfo());
    expect(inj.build(baseCtx({ conversationSize: 2 }))).toBeNull();
  });

  it("returns null when skipTranscript is true", () => {
    const inj = new BehaviorInjection();
    for (let i = 0; i < 5; i++) inj.afterResponse(responseInfo());
    expect(inj.build(baseCtx({ conversationSize: 5, skipTranscript: true }))).toBeNull();
  });

  it("returns null when counters are below threshold", () => {
    const inj = new BehaviorInjection();
    // No afterResponse calls — counters are 0
    expect(inj.build(baseCtx({ conversationSize: 5 }))).toBeNull();
  });

  it("returns tool reminder after threshold turns without tools", () => {
    const inj = new BehaviorInjection();
    for (let i = 0; i < 3; i++) {
      inj.afterResponse(responseInfo({ text: '<color=#20b2aa>item</color>' }));
    }
    const result = inj.build(baseCtx({ conversationSize: 5 }));
    expect(result).toBe("[dm-note] use your tools.");
  });

  it("returns entity reminder after threshold turns without entities", () => {
    const inj = new BehaviorInjection();
    for (let i = 0; i < 3; i++) {
      inj.afterResponse(responseInfo({ toolUsed: true, text: "plain text" }));
    }
    const result = inj.build(baseCtx({ conversationSize: 5 }));
    expect(result).toBe("[dm-note] color-code entity names.");
  });

  it("returns combined reminder when both overdue", () => {
    const inj = new BehaviorInjection();
    for (let i = 0; i < 3; i++) {
      inj.afterResponse(responseInfo({ text: "plain text" }));
    }
    const result = inj.build(baseCtx({ conversationSize: 5 }));
    expect(result).toBe("[dm-note] use your tools; color-code entity names.");
  });

  it("resets tool counter when toolUsed is true", () => {
    const inj = new BehaviorInjection();
    for (let i = 0; i < 3; i++) inj.afterResponse(responseInfo());
    inj.afterResponse(responseInfo({ toolUsed: true }));
    // Entity counter is still at 4, tool counter is 0
    const result = inj.build(baseCtx({ conversationSize: 5 }));
    expect(result).toBe("[dm-note] color-code entity names.");
  });

  it("resets entity counter on color tags", () => {
    const inj = new BehaviorInjection();
    for (let i = 0; i < 3; i++) inj.afterResponse(responseInfo());
    inj.afterResponse(responseInfo({ text: '<color=#ff0000>NPC</color>' }));
    // Tool counter is still at 4, entity counter is 0
    const result = inj.build(baseCtx({ conversationSize: 5 }));
    expect(result).toBe("[dm-note] use your tools.");
  });

  it("skips afterResponse for AI turns", () => {
    const inj = new BehaviorInjection();
    for (let i = 0; i < 5; i++) inj.afterResponse(responseInfo({ fromAI: true }));
    // Counters should still be 0
    expect(inj.build(baseCtx({ conversationSize: 5 }))).toBeNull();
  });

  it("reset() clears both counters", () => {
    const inj = new BehaviorInjection();
    for (let i = 0; i < 5; i++) inj.afterResponse(responseInfo());
    inj.reset();
    expect(inj.build(baseCtx({ conversationSize: 5 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ScenePacingInjection
// ---------------------------------------------------------------------------

describe("ScenePacingInjection", () => {
  it("returns null when conversationSize is 0", () => {
    const inj = new ScenePacingInjection();
    expect(inj.build(baseCtx({ conversationSize: 0 }))).toBeNull();
  });

  it("returns null when conversationSize is not divisible by 3", () => {
    const inj = new ScenePacingInjection();
    expect(inj.build(baseCtx({ conversationSize: 4 }))).toBeNull();
  });

  it("returns pacing at conversationSize divisible by 3", () => {
    const scene = mockScene({
      transcript: ["**[Alice]** Hello", "**DM:** Welcome."],
      openThreads: "[[quest-a]], [[quest-b]]",
    });
    const inj = new ScenePacingInjection();
    const result = inj.build(baseCtx({ conversationSize: 3, scene }));
    expect(result).toContain("[scene-pacing]");
    expect(result).toContain("Exchanges: 1");
  });

  it("returns null when buildScenePacing returns undefined (no player lines)", () => {
    const scene = mockScene({ transcript: ["**DM:** Just me."] });
    const inj = new ScenePacingInjection();
    expect(inj.build(baseCtx({ conversationSize: 3, scene }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LengthSteeringInjection
// ---------------------------------------------------------------------------

describe("LengthSteeringInjection", () => {
  it("returns null when terminalDims is undefined", () => {
    const inj = new LengthSteeringInjection();
    expect(inj.build(baseCtx())).toBeNull();
  });

  it("injects terminal size on first call", () => {
    const inj = new LengthSteeringInjection();
    const result = inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    expect(result).toContain("[length]");
    expect(result).toContain("100 cols");
    expect(result).toContain("25 visible rows");
    expect(result).toContain("≤ 1 page");
  });

  it("returns null on subsequent calls when dims unchanged and no overlong", () => {
    const inj = new LengthSteeringInjection();
    const ctx = baseCtx({ terminalDims: dims(100, 40, 25) });
    inj.build(ctx); // first call — injects
    expect(inj.build(ctx)).toBeNull(); // second call — nothing new
  });

  it("re-injects when terminal size changes", () => {
    const inj = new LengthSteeringInjection();
    inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    const result = inj.build(baseCtx({ terminalDims: dims(120, 50, 35) }));
    expect(result).toContain("120 cols");
    expect(result).toContain("35 visible rows");
  });

  it("re-injects when only narrativeRows changes", () => {
    const inj = new LengthSteeringInjection();
    inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    const result = inj.build(baseCtx({ terminalDims: dims(100, 40, 20) }));
    expect(result).toContain("20 visible rows");
  });

  it("does not inject overlong reminder after only 1 overlong response", () => {
    const inj = new LengthSteeringInjection();
    inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    inj.afterResponse(responseInfo({ wrappedLineCount: 30 })); // > 25
    const result = inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    // No overlong reminder (threshold is 2), and dims unchanged → null
    expect(result).toBeNull();
  });

  it("injects overlong reminder after 2 consecutive overlong responses", () => {
    const inj = new LengthSteeringInjection();
    inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    inj.afterResponse(responseInfo({ wrappedLineCount: 30 }));
    inj.afterResponse(responseInfo({ wrappedLineCount: 28 }));
    const result = inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    expect(result).toContain("[length]");
    expect(result).toContain("last 2 responses exceeded one page");
    expect(result).toContain("concise");
  });

  it("includes overlong count in message for 3+ overlong turns", () => {
    const inj = new LengthSteeringInjection();
    inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    for (let i = 0; i < 4; i++) {
      inj.afterResponse(responseInfo({ wrappedLineCount: 30 }));
    }
    const result = inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    expect(result).toContain("last 4 responses");
  });

  it("resets overlong counter when a response fits in one page", () => {
    const inj = new LengthSteeringInjection();
    inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    inj.afterResponse(responseInfo({ wrappedLineCount: 30 }));
    inj.afterResponse(responseInfo({ wrappedLineCount: 30 }));
    // Now inject a short response
    inj.afterResponse(responseInfo({ wrappedLineCount: 20 }));
    const result = inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    expect(result).toBeNull(); // counter reset, dims unchanged
  });

  it("ignores AI turns for overlong tracking", () => {
    const inj = new LengthSteeringInjection();
    inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    inj.afterResponse(responseInfo({ wrappedLineCount: 30, fromAI: true }));
    inj.afterResponse(responseInfo({ wrappedLineCount: 30, fromAI: true }));
    const result = inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    expect(result).toBeNull();
  });

  it("does not track overlong before dims are reported", () => {
    const inj = new LengthSteeringInjection();
    // afterResponse before any build() — lastReportedDims is undefined
    inj.afterResponse(responseInfo({ wrappedLineCount: 100 }));
    inj.afterResponse(responseInfo({ wrappedLineCount: 100 }));
    // First build should just report dims, no overlong
    const result = inj.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    expect(result).toContain("100 cols");
    expect(result).not.toContain("exceeded");
  });
});

// ---------------------------------------------------------------------------
// InjectionRegistry
// ---------------------------------------------------------------------------

describe("InjectionRegistry", () => {
  it("buildAll collects results from all injections that fire", () => {
    const reg = new InjectionRegistry();
    reg.register(new ScenePacingInjection()); // won't fire at size=0
    reg.register(new LengthSteeringInjection());
    const results = reg.buildAll(baseCtx({ terminalDims: dims() }));
    expect(results).toHaveLength(1); // only length steering
    expect(results[0]).toContain("[length]");
  });

  it("buildAll invokes devLog for each fired injection", () => {
    const reg = new InjectionRegistry();
    reg.register(new LengthSteeringInjection());
    const logged: string[] = [];
    reg.buildAll(baseCtx({ terminalDims: dims() }), (msg) => logged.push(msg));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("injection(length)");
  });

  it("afterResponse is called on all injections", () => {
    const reg = new InjectionRegistry();
    const behavior = new BehaviorInjection();
    const length = new LengthSteeringInjection();
    reg.register(behavior);
    reg.register(length);

    // Initialize length dims
    length.build(baseCtx({ terminalDims: dims(100, 40, 25) }));

    // 3 responses to exceed behavior threshold; all overlong for length
    for (let i = 0; i < 3; i++) {
      reg.afterResponse(responseInfo({ wrappedLineCount: 30 }));
    }

    // Both should have updated their counters
    const behaviorResult = behavior.build(baseCtx({ conversationSize: 5 }));
    expect(behaviorResult).toContain("use your tools");

    const lengthResult = length.build(baseCtx({ terminalDims: dims(100, 40, 25) }));
    expect(lengthResult).toContain("exceeded");
  });

  it("get() retrieves injection by name", () => {
    const reg = new InjectionRegistry();
    const behavior = new BehaviorInjection();
    reg.register(behavior);
    expect(reg.get("behavior")).toBe(behavior);
    expect(reg.get("nonexistent")).toBeUndefined();
  });
});
