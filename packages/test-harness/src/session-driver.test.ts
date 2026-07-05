import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionId, sessionPaths, DEFAULT_SESSION_ID } from "./session-driver.js";

const norm = (p: string): string => p.replace(/\\/g, "/");
const ROOT = norm(join(tmpdir(), "mvplay"));

describe("resolveSessionId", () => {
  const saved = process.env.MVPLAY_SESSION;
  beforeEach(() => { delete process.env.MVPLAY_SESSION; });
  afterEach(() => {
    if (saved === undefined) delete process.env.MVPLAY_SESSION;
    else process.env.MVPLAY_SESSION = saved;
  });

  it("defaults to the default id when nothing is given", () => {
    expect(resolveSessionId()).toBe(DEFAULT_SESSION_ID);
    expect(resolveSessionId("")).toBe(DEFAULT_SESSION_ID);
  });

  it("prefers an explicit id over the env var over the default", () => {
    process.env.MVPLAY_SESSION = "from-env";
    expect(resolveSessionId("explicit")).toBe("explicit"); // explicit wins
    expect(resolveSessionId()).toBe("from-env");            // env when no explicit
    delete process.env.MVPLAY_SESSION;
    expect(resolveSessionId()).toBe(DEFAULT_SESSION_ID);    // default when neither
  });

  it("sanitizes filesystem-unsafe characters so an id can't escape the root", () => {
    expect(resolveSessionId("a/b\\c")).toBe("abc");        // slashes stripped
    expect(resolveSessionId("weird id!@#")).toBe("weirdid"); // punctuation/spaces stripped
    expect(resolveSessionId("keep.dot_dash-1")).toBe("keep.dot_dash-1"); // safe chars survive
  });

  it("maps traversal ids (., ..) and all-unsafe ids to the default", () => {
    // '.' / '..' survive the char class but join()'d would be the root or its
    // PARENT — must never become a real session dir.
    expect(resolveSessionId(".")).toBe(DEFAULT_SESSION_ID);
    expect(resolveSessionId("..")).toBe(DEFAULT_SESSION_ID);
    expect(resolveSessionId("///")).toBe(DEFAULT_SESSION_ID);
  });
});

describe("sessionPaths", () => {
  it("lays every session out under its own subdir of the sessions root", () => {
    const p = sessionPaths("alpha");
    expect(p.id).toBe("alpha");
    expect(norm(p.dir)).toBe(`${ROOT}/alpha`);
    expect(norm(p.file)).toBe(`${ROOT}/alpha/session.json`);
    expect(norm(p.log)).toBe(`${ROOT}/alpha/launcher.log`);
    expect(norm(p.campaignsDir)).toBe(`${ROOT}/alpha/campaigns`);
  });

  it("keeps distinct sessions fully disjoint (no shared file/log/campaigns)", () => {
    const a = sessionPaths("a");
    const b = sessionPaths("b");
    expect(a.dir).not.toBe(b.dir);
    expect(a.file).not.toBe(b.file);
    expect(a.log).not.toBe(b.log);
    expect(a.campaignsDir).not.toBe(b.campaignsDir);
  });

  it("puts the default session under its own subdir too (back-compat isolation)", () => {
    expect(norm(sessionPaths(DEFAULT_SESSION_ID).dir)).toBe(`${ROOT}/default`);
  });
});
