import { describe, it, expect } from "vitest";
import { applyModelConditionals } from "./apply-model-conditionals.js";

describe("applyModelConditionals", () => {
  describe("passthrough", () => {
    it("returns text unchanged when no conditionals present", () => {
      const input = "Plain prompt with no conditionals.\nLine two.\n";
      expect(applyModelConditionals(input, "gpt-5")).toBe(input);
    });

    it("returns text unchanged when modelId is undefined and no conditionals", () => {
      const input = "Plain prompt.";
      expect(applyModelConditionals(input, undefined)).toBe(input);
    });
  });

  describe("prefix matching", () => {
    it("includes if-body when modelId starts with prefix", () => {
      const input = "before <!--if:gpt-->QUIRK<!--endif--> after";
      expect(applyModelConditionals(input, "gpt-5")).toBe("before QUIRK after");
    });

    it("omits if-body (no else) when prefix does not match", () => {
      const input = "before <!--if:gpt-->QUIRK<!--endif--> after";
      expect(applyModelConditionals(input, "claude-opus-4-7")).toBe("before  after");
    });

    it("matches exact model id as prefix", () => {
      const input = "<!--if:claude-opus-4-7-->exact<!--endif-->";
      expect(applyModelConditionals(input, "claude-opus-4-7")).toBe("exact");
    });

    it("matches partial prefix", () => {
      const input = "<!--if:claude-->any-claude<!--endif-->";
      expect(applyModelConditionals(input, "claude-opus-4-7")).toBe("any-claude");
      expect(applyModelConditionals(input, "claude-sonnet-4-6")).toBe("any-claude");
    });

    it("does not match when modelId is a prefix of the marker, not vice versa", () => {
      const input = "<!--if:gpt-5.5-->only5.5<!--endif-->";
      expect(applyModelConditionals(input, "gpt-5")).toBe("");
    });
  });

  describe("else clause", () => {
    it("uses else-body when prefix does not match", () => {
      const input = "<!--if:gpt-->A<!--else-->B<!--endif-->";
      expect(applyModelConditionals(input, "claude-opus-4-7")).toBe("B");
    });

    it("uses if-body and ignores else when prefix matches", () => {
      const input = "<!--if:gpt-->A<!--else-->B<!--endif-->";
      expect(applyModelConditionals(input, "gpt-5")).toBe("A");
    });

    it("handles empty else body", () => {
      const input = "<!--if:gpt-->A<!--else--><!--endif-->";
      expect(applyModelConditionals(input, "claude-opus-4-7")).toBe("");
    });

    it("handles empty if body with non-empty else", () => {
      const input = "<!--if:gpt--><!--else-->fallback<!--endif-->";
      expect(applyModelConditionals(input, "claude-opus-4-7")).toBe("fallback");
    });
  });

  describe("undefined modelId", () => {
    it("falls through to else when modelId is undefined", () => {
      const input = "<!--if:gpt-->A<!--else-->B<!--endif-->";
      expect(applyModelConditionals(input, undefined)).toBe("B");
    });

    it("omits if-body (no else) when modelId is undefined", () => {
      const input = "before <!--if:gpt-->QUIRK<!--endif--> after";
      expect(applyModelConditionals(input, undefined)).toBe("before  after");
    });
  });

  describe("multiple conditionals", () => {
    it("processes multiple conditionals in one document", () => {
      const input = [
        "<!--if:gpt-->one<!--endif-->",
        "middle",
        "<!--if:claude-->two<!--else-->two-fallback<!--endif-->",
        "end",
      ].join("\n");
      expect(applyModelConditionals(input, "gpt-5")).toBe("one\nmiddle\ntwo-fallback\nend");
      expect(applyModelConditionals(input, "claude-opus-4-7")).toBe("\nmiddle\ntwo\nend");
    });

    it("does not greedily consume across conditionals", () => {
      const input = "<!--if:gpt-->A<!--endif-->X<!--if:gpt-->B<!--endif-->";
      expect(applyModelConditionals(input, "gpt-5")).toBe("AXB");
    });
  });

  describe("multiline bodies", () => {
    it("handles bodies that span multiple lines", () => {
      const input = [
        "<!--if:gpt-->",
        "Line 1",
        "Line 2",
        "<!--else-->",
        "Other 1",
        "Other 2",
        "<!--endif-->",
      ].join("\n");
      expect(applyModelConditionals(input, "gpt-5")).toBe("\nLine 1\nLine 2\n");
      expect(applyModelConditionals(input, "claude-opus-4-7")).toBe("\nOther 1\nOther 2\n");
    });
  });
});
