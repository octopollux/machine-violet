import { describe, it, expect } from "vitest";
import { computeViewportFloor } from "./session-manager.js";

interface Dims {
  columns: number;
  rows: number;
  narrativeRows: number;
}

function client(dims: Dims | undefined): { dims?: Dims } {
  return dims ? { dims } : {};
}

describe("computeViewportFloor", () => {
  it("returns undefined when no clients have reported", () => {
    expect(computeViewportFloor([])).toBeUndefined();
    expect(computeViewportFloor([client(undefined)])).toBeUndefined();
  });

  it("returns the only reported entry when exactly one client has dims", () => {
    const floor = computeViewportFloor([client({ columns: 100, rows: 40, narrativeRows: 25 })]);
    expect(floor).toEqual({ columns: 100, rows: 40, narrativeRows: 25 });
  });

  it("picks the entry with the smallest narrativeRows", () => {
    const floor = computeViewportFloor([
      client({ columns: 120, rows: 50, narrativeRows: 35 }),
      client({ columns: 80, rows: 24, narrativeRows: 15 }),
      client({ columns: 100, rows: 40, narrativeRows: 25 }),
    ]);
    expect(floor?.narrativeRows).toBe(15);
    expect(floor?.columns).toBe(80);
  });

  it("ignores clients that have not reported", () => {
    const floor = computeViewportFloor([
      client(undefined),
      client({ columns: 100, rows: 40, narrativeRows: 25 }),
      client(undefined),
    ]);
    expect(floor?.narrativeRows).toBe(25);
  });

  it("rises when the previously-smallest client raises its value (re-min)", () => {
    // Simulates a resize: the smallest client A reports a larger value;
    // floor should re-min to whoever is now smallest.
    const a: { dims?: Dims } = { dims: { columns: 80, rows: 24, narrativeRows: 15 } };
    const b: { dims?: Dims } = { dims: { columns: 100, rows: 40, narrativeRows: 25 } };
    expect(computeViewportFloor([a, b])?.narrativeRows).toBe(15);
    a.dims = { columns: 120, rows: 50, narrativeRows: 30 };
    expect(computeViewportFloor([a, b])?.narrativeRows).toBe(25);
  });

  it("uses the next-smallest value when the smallest client disconnects", () => {
    const a = client({ columns: 80, rows: 24, narrativeRows: 15 });
    const b = client({ columns: 100, rows: 40, narrativeRows: 25 });
    expect(computeViewportFloor([a, b])?.narrativeRows).toBe(15);
    // a disconnects — simulate by passing only b
    expect(computeViewportFloor([b])?.narrativeRows).toBe(25);
  });

  it("picks the narrower columns on a narrativeRows tie", () => {
    // Same narrativeRows but different widths — without tiebreak, the
    // chosen `columns` would be insertion-order-dependent, which
    // mis-sizes GameEngine.wrappedLineCount.
    const wide = client({ columns: 200, rows: 50, narrativeRows: 30 });
    const narrow = client({ columns: 80, rows: 50, narrativeRows: 30 });
    expect(computeViewportFloor([wide, narrow])?.columns).toBe(80);
    expect(computeViewportFloor([narrow, wide])?.columns).toBe(80);
  });

  it("picks the smaller rows on a (narrativeRows, columns) tie", () => {
    // Same narrativeRows AND same columns but different total rows —
    // tertiary tiebreak so the result is fully deterministic.
    const tall = client({ columns: 80, rows: 60, narrativeRows: 30 });
    const short = client({ columns: 80, rows: 40, narrativeRows: 30 });
    expect(computeViewportFloor([tall, short])?.rows).toBe(40);
    expect(computeViewportFloor([short, tall])?.rows).toBe(40);
  });
});
