/**
 * Contract test: validates the shape of context dump JSON envelopes
 * that the Campaign Explorer's ContextDumpViewer depends on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dumpContext,
  dumpThinking,
  setContextDumpDir,
  resetContextDump,
} from "../../../../src/config/context-dump.js";
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}));

beforeEach(() => {
  resetContextDump();
  setContextDumpDir("/tmp/contract-test");
});

afterEach(() => {
  resetContextDump();
});

describe("context dump envelope contract", () => {
  it("has required top-level fields: agent, timestamp", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();

    dumpContext("dm", { model: "test", messages: [] });
    await new Promise((r) => setTimeout(r, 10));

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).endsWith("dm.json"),
    );
    expect(written).toBeDefined();

    const parsed = JSON.parse(written![1] as string);
    expect(parsed).toHaveProperty("agent");
    expect(parsed).toHaveProperty("timestamp");
    expect(typeof parsed.agent).toBe("string");
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes _thinking_trace when thinking was accumulated", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();

    dumpThinking("dm", 1, "Some thinking text");
    dumpContext("dm", { model: "test", messages: [] });
    await new Promise((r) => setTimeout(r, 10));

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).endsWith("dm.json"),
    );
    const parsed = JSON.parse(written![1] as string);

    expect(parsed._thinking_trace).toBeDefined();
    expect(Array.isArray(parsed._thinking_trace)).toBe(true);
    expect(parsed._thinking_trace[0]).toHaveProperty("round");
    expect(parsed._thinking_trace[0]).toHaveProperty("thinking");
    expect(parsed._thinking_trace[0]).toHaveProperty("timestamp");
  });

  it("omits _thinking_trace when no thinking was accumulated", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();

    dumpContext("dm", { model: "test", messages: [] });
    await new Promise((r) => setTimeout(r, 10));

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).endsWith("dm.json"),
    );
    const parsed = JSON.parse(written![1] as string);

    expect(parsed._thinking_trace).toBeUndefined();
  });
});
