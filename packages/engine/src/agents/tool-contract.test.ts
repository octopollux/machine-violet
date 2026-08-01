import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as engineLog from "../context/engine-log.js";
import {
  defineToolContract,
  describeToolInputValue,
  validateToolInput,
  type ToolInputRepair,
} from "./tool-contract.js";

const CONTEXT = {
  agent: "test-agent",
  provider: "test-provider",
  model: "test-model",
  callId: "call-123",
};

describe("tool input contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses one TypeBox schema for the wire definition and runtime validation", () => {
    const contract = defineToolContract({
      name: "record_tags",
      description: "Record tags.",
      criticality: "durable",
      schema: Type.Object({
        subject: Type.String({ minLength: 1 }),
        tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      }, { additionalProperties: false }),
    });

    expect(contract.definition.inputSchema).toBe(contract.schema);
    expect(validateToolInput(
      contract.definition,
      { subject: "The Gate", tags: ["sealed"] },
      contract.policy,
    )).toEqual({
      ok: true,
      value: { subject: "The Gate", tags: ["sealed"] },
      repairs: [],
    });
  });

  it("returns actionable structural errors without exposing raw prose in logs", () => {
    const logSpy = vi.spyOn(engineLog, "logEvent").mockImplementation(() => {});
    const secret = "The hidden prince is alive";
    const contract = defineToolContract({
      name: "record_tags",
      description: "Record tags.",
      criticality: "durable",
      schema: Type.Object({
        subject: Type.String({ minLength: 1 }),
        tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      }, { additionalProperties: false }),
    });

    const result = validateToolInput(
      contract.definition,
      { subject: secret, tags: "sealed", surprise: secret },
      contract.policy,
      CONTEXT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation failure");
    expect(result.content).toContain("/tags");
    expect(result.content).toContain("/surprise");
    expect(result.content).toContain("No side effects were applied");
    expect(result.content).not.toContain(secret);
    expect(logSpy).toHaveBeenCalledWith(
      "tool_input:rejected",
      expect.objectContaining({
        agent: "test-agent",
        provider: "test-provider",
        model: "test-model",
        callId: "call-123",
        tool: "record_tags",
        criticality: "durable",
        issueCount: 2,
        retryable: true,
      }),
    );
    expect(JSON.stringify(logSpy.mock.calls[0]?.[1])).not.toContain(secret);
  });

  it("applies only the contract's allowlisted repair before validation and logs it", () => {
    const logSpy = vi.spyOn(engineLog, "logEvent").mockImplementation(() => {});
    const repair = (raw: unknown): { input: unknown; repairs: ToolInputRepair[] } => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { input: raw, repairs: [] };
      }
      const input = { ...(raw as Record<string, unknown>) };
      if (typeof input.tags !== "string") return { input, repairs: [] };
      const tags = input.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      const repairs: ToolInputRepair[] = [{
        path: "/tags",
        code: "csv_to_string_array",
        from: describeToolInputValue(input.tags),
        to: describeToolInputValue(tags),
        message: "Accepted an unambiguous comma-separated tag list.",
      }];
      input.tags = tags;
      return { input, repairs };
    };
    const contract = defineToolContract({
      name: "record_tags",
      description: "Record tags.",
      criticality: "durable",
      schema: Type.Object({
        tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      }),
      repair,
    });

    const result = validateToolInput(
      contract.definition,
      { tags: "sealed, watched" },
      contract.policy,
      CONTEXT,
    );

    expect(result).toEqual({
      ok: true,
      value: { tags: ["sealed", "watched"] },
      repairs: [expect.objectContaining({ code: "csv_to_string_array" })],
    });
    expect(logSpy).toHaveBeenCalledWith(
      "tool_input:repaired",
      expect.objectContaining({
        tool: "record_tags",
        criticality: "durable",
        repairCount: 1,
      }),
    );
  });

  it("rejects semantic contract violations after structural validation", () => {
    const contract = defineToolContract({
      name: "choose",
      description: "Choose an option.",
      criticality: "commit",
      schema: Type.Object({
        choices: Type.Array(Type.String(), { minItems: 2 }),
        descriptions: Type.Array(Type.String()),
      }),
      refine: (input) => input.choices.length === input.descriptions.length
        ? []
        : [{
            path: "/descriptions",
            code: "parallel_array_length",
            expected: `array length ${input.choices.length}`,
            actual: describeToolInputValue(input.descriptions),
            message: "/descriptions: must have exactly one description per choice",
          }],
    });

    const result = validateToolInput(
      contract.definition,
      { choices: ["A", "B"], descriptions: ["only A"] },
      contract.policy,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation failure");
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: "/descriptions",
        code: "parallel_array_length",
      }),
    ]);
  });
});
