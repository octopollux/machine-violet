import { describe, expect, it } from "vitest";
import {
  buildTranscriptChoiceResolution,
  buildTranscriptStateCheckpoint,
} from "./session-manager.js";

describe("buildTranscriptStateCheckpoint", () => {
  it("normalizes resource keys and deep-copies mutable live state", () => {
    const modelines = { Aldric: "At the gate" };
    const displayResources: Record<string, string[] | string> = {
      Aldric: "HP, Air",
    };
    const resourceValues = {
      Aldric: { HP: "18/30", Air: "4/6" },
    };

    const checkpoint = buildTranscriptStateCheckpoint(
      modelines,
      displayResources,
      resourceValues,
    );

    modelines.Aldric = "Somewhere else";
    displayResources.Aldric = ["Power"];
    resourceValues.Aldric.HP = "30/30";

    expect(checkpoint).toEqual({
      version: 1,
      modelines: { Aldric: "At the gate" },
      displayResources: { Aldric: ["HP", "Air"] },
      resourceValues: { Aldric: { HP: "18/30", Air: "4/6" } },
    });
  });
});

describe("buildTranscriptChoiceResolution", () => {
  const presentation = {
    id: "choice-1",
    source: "suggestion_generator" as const,
    prompt: "",
    choices: ["◆ <b>Open</b> the door", "◆ Wait"],
  };

  it("links the accepted plain contribution by stable option index", () => {
    expect(buildTranscriptChoiceResolution(
      presentation,
      { presentationId: "choice-1", kind: "option", optionIndex: 0 },
      "Aldric",
      "Open the door",
    )).toEqual({
      presentationId: "choice-1",
      kind: "option",
      optionIndex: 0,
      playerId: "Aldric",
      contributionText: "Open the door",
    });
  });

  it("rejects stale IDs and out-of-range indices", () => {
    expect(() => buildTranscriptChoiceResolution(
      presentation,
      { presentationId: "old-choice", kind: "option", optionIndex: 0 },
      "Aldric",
      "Open the door",
    )).toThrow("does not match");
    expect(() => buildTranscriptChoiceResolution(
      presentation,
      { presentationId: "choice-1", kind: "option", optionIndex: 2 },
      "Aldric",
      "Open the door",
    )).toThrow("out of range");
  });
});
