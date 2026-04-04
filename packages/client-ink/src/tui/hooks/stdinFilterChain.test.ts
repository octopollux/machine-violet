import { describe, it, expect, vi } from "vitest";
import { installStdinFilterChain } from "./stdinFilterChain.js";
import type { StdinFilter, ReadableStdin } from "./stdinFilterChain.js";

function makeInput(data: string | null): ReadableStdin {
  return { read: vi.fn(() => data) };
}

describe("installStdinFilterChain", () => {
  it("passes through chunks when no filters are registered", () => {
    const input = makeInput("hello");
    const chain = installStdinFilterChain(input);
    expect(input.read()).toBe("hello");
    chain.teardown();
  });

  it("runs a single filter", () => {
    const input = makeInput("abc123def");
    const chain = installStdinFilterChain(input);

    chain.add({
      name: "digits",
      process: (data) => {
        const stripped = data.replace(/\d+/g, "");
        return stripped.length === 0 ? null : stripped;
      },
    });

    expect(input.read()).toBe("abcdef");
    chain.teardown();
  });

  it("runs filters in registration order", () => {
    const order: string[] = [];
    const input = makeInput("data");
    const chain = installStdinFilterChain(input);

    chain.add({
      name: "first",
      process: (data) => { order.push("first"); return data; },
    });
    chain.add({
      name: "second",
      process: (data) => { order.push("second"); return data; },
    });

    input.read();
    expect(order).toEqual(["first", "second"]);
    chain.teardown();
  });

  it("short-circuits when a filter returns null", () => {
    const secondCalled = vi.fn();
    const input = makeInput("data");
    const chain = installStdinFilterChain(input);

    chain.add({
      name: "consume-all",
      process: () => null,
    });
    chain.add({
      name: "should-not-run",
      process: (data) => { secondCalled(); return data; },
    });

    const result = input.read();
    expect(result).toBe(""); // empty string, not null
    expect(secondCalled).not.toHaveBeenCalled();
    chain.teardown();
  });

  it("returns empty Buffer when Buffer chunk is fully consumed", () => {
    const input: ReadableStdin = { read: vi.fn(() => Buffer.from("data")) };
    const chain = installStdinFilterChain(input);

    chain.add({ name: "consume", process: () => null });

    const result = input.read();
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).length).toBe(0);
    chain.teardown();
  });

  it("preserves Buffer type on partial consumption", () => {
    const input: ReadableStdin = { read: vi.fn(() => Buffer.from("ab12cd")) };
    const chain = installStdinFilterChain(input);

    chain.add({
      name: "strip-digits",
      process: (data) => data.replace(/\d+/g, "") || null,
    });

    const result = input.read();
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result?.toString()).toBe("abcd");
    chain.teardown();
  });

  it("returns null when original read returns null", () => {
    const input = makeInput(null);
    const chain = installStdinFilterChain(input);
    chain.add({ name: "noop", process: (d) => d });
    expect(input.read()).toBeNull();
    chain.teardown();
  });

  it("add() returns a remove function", () => {
    const calls: string[] = [];
    // Use a function that always returns data (not a one-shot mock)
    const input: ReadableStdin = { read: () => "data" };
    const chain = installStdinFilterChain(input);

    const remove = chain.add({
      name: "tracker",
      process: (data) => { calls.push("called"); return data; },
    });

    input.read();
    expect(calls).toEqual(["called"]);

    remove();
    calls.length = 0;
    input.read(); // chain still wraps read, but filter is removed
    expect(calls).toEqual([]);

    chain.teardown();
  });

  it("teardown restores original read and clears filters", () => {
    const original = vi.fn(() => "original");
    const input: ReadableStdin = { read: original };
    const chain = installStdinFilterChain(input);

    const filterCalled = vi.fn();
    chain.add({ name: "test", process: (d) => { filterCalled(); return d; } });

    chain.teardown();

    // After teardown, read should hit the original (bound) version
    input.read();
    expect(filterCalled).not.toHaveBeenCalled();
  });

  it("supports multiple add/remove cycles", () => {
    const input = makeInput("data");
    const chain = installStdinFilterChain(input);
    const log: string[] = [];

    const f1: StdinFilter = { name: "f1", process: (d) => { log.push("f1"); return d; } };
    const f2: StdinFilter = { name: "f2", process: (d) => { log.push("f2"); return d; } };

    const rm1 = chain.add(f1);
    const rm2 = chain.add(f2);

    input.read();
    expect(log).toEqual(["f1", "f2"]);

    // Remove f1, f2 still runs
    rm1();
    log.length = 0;
    input.read();
    expect(log).toEqual(["f2"]);

    // Remove f2, no filters run
    rm2();
    log.length = 0;
    input.read();
    expect(log).toEqual([]);

    // Re-add f1
    chain.add(f1);
    log.length = 0;
    input.read();
    expect(log).toEqual(["f1"]);

    chain.teardown();
  });
});
