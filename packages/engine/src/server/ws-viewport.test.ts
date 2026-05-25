import { describe, it, expect } from "vitest";
import { sanitizeClientViewport } from "./ws.js";

describe("sanitizeClientViewport", () => {
  const VALID = { columns: 120, rows: 50, narrativeRows: 32 };

  it("accepts a well-formed payload", () => {
    expect(sanitizeClientViewport(VALID)).toEqual(VALID);
  });

  it("rejects non-object inputs", () => {
    expect(sanitizeClientViewport(null)).toBeNull();
    expect(sanitizeClientViewport(undefined)).toBeNull();
    expect(sanitizeClientViewport("hello")).toBeNull();
    expect(sanitizeClientViewport(42)).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(sanitizeClientViewport({ columns: 80, rows: 24 })).toBeNull();
    expect(sanitizeClientViewport({ columns: 80, narrativeRows: 20 })).toBeNull();
    expect(sanitizeClientViewport({ rows: 24, narrativeRows: 20 })).toBeNull();
  });

  it("rejects non-numeric fields", () => {
    expect(sanitizeClientViewport({ ...VALID, columns: "120" })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, rows: null })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, narrativeRows: [] })).toBeNull();
  });

  it("rejects non-finite numbers", () => {
    expect(sanitizeClientViewport({ ...VALID, columns: Number.POSITIVE_INFINITY })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, rows: Number.NaN })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, narrativeRows: Number.NEGATIVE_INFINITY })).toBeNull();
  });

  it("rejects floats — terminal dims are integer-only", () => {
    expect(sanitizeClientViewport({ ...VALID, columns: 120.5 })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, rows: 50.1 })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, narrativeRows: 32.9 })).toBeNull();
  });

  it("rejects zero and negative values", () => {
    expect(sanitizeClientViewport({ ...VALID, columns: 0 })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, rows: -10 })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, narrativeRows: 0 })).toBeNull();
  });

  it("rejects values above the 10k ceiling", () => {
    expect(sanitizeClientViewport({ ...VALID, columns: 100_000 })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, rows: 50_000 })).toBeNull();
    expect(sanitizeClientViewport({ ...VALID, narrativeRows: 20_000 })).toBeNull();
  });

  it("rejects narrativeRows greater than rows", () => {
    // narrativeRows is supposed to be a subset of the full terminal
    // height; a client claiming more narrative rows than total rows is
    // confused (or malicious).
    expect(sanitizeClientViewport({ columns: 80, rows: 24, narrativeRows: 30 })).toBeNull();
  });

  it("accepts narrativeRows equal to rows (no chrome)", () => {
    expect(sanitizeClientViewport({ columns: 80, rows: 24, narrativeRows: 24 })).toEqual({
      columns: 80,
      rows: 24,
      narrativeRows: 24,
    });
  });
});
