import { describe, it, expect } from "vitest";
import { readAppVersion, versionBanner, versionFile, UNKNOWN_VERSION } from "./app-version.js";
import { norm } from "../utils/paths.js";

describe("versionFile", () => {
  it("points at version.json beside the exe when compiled", () => {
    expect(norm(versionFile({ compiled: true, execPath: "/opt/mv/MachineViolet" })))
      .toBe("/opt/mv/version.json");
  });

  it("points at the monorepo package.json in dev", () => {
    expect(norm(versionFile({ compiled: false, repoRoot: "/repo" })))
      .toBe("/repo/package.json");
  });
});

describe("readAppVersion", () => {
  it("reads version.json from the install dir when compiled", () => {
    const version = readAppVersion({
      compiled: true,
      execPath: "/opt/mv/MachineViolet",
      readFile: (p) => {
        expect(norm(p)).toBe("/opt/mv/version.json");
        return JSON.stringify({ version: "1.1.0-rc.2", releaseDate: "2026-07-04 21:08" });
      },
    });
    expect(version).toBe("1.1.0-rc.2");
  });

  it("reads package.json in dev", () => {
    const version = readAppVersion({
      compiled: false,
      repoRoot: "/repo",
      readFile: () => JSON.stringify({ version: "1.2.3" }),
    });
    expect(version).toBe("1.2.3");
  });

  it("returns unknown rather than throwing when the file is absent", () => {
    const version = readAppVersion({
      compiled: true,
      execPath: "/opt/mv/MachineViolet",
      readFile: () => { throw new Error("ENOENT"); },
    });
    expect(version).toBe(UNKNOWN_VERSION);
  });

  it("returns unknown on malformed JSON", () => {
    const version = readAppVersion({
      compiled: true,
      execPath: "/opt/mv/MachineViolet",
      readFile: () => "not json{",
    });
    expect(version).toBe(UNKNOWN_VERSION);
  });

  it.each([
    ["missing version key", JSON.stringify({ releaseDate: "x" })],
    ["non-string version", JSON.stringify({ version: 42 })],
    ["empty version", JSON.stringify({ version: "" })],
    ["json null", "null"],
  ])("returns unknown for %s", (_label, payload) => {
    expect(readAppVersion({ compiled: true, execPath: "/x/MachineViolet", readFile: () => payload }))
      .toBe(UNKNOWN_VERSION);
  });
});

describe("versionBanner", () => {
  // The Homebrew formula's `test do` block asserts the --version output matches
  // "MachineViolet", and install.sh echoes it as the post-install confirmation.
  // Dropping the product name would silently break `brew test`.
  it("includes the product name and the version", () => {
    const banner = versionBanner({
      compiled: true,
      execPath: "/opt/mv/MachineViolet",
      readFile: () => JSON.stringify({ version: "1.1.0" }),
    });
    expect(banner).toBe("MachineViolet 1.1.0");
    expect(banner).toMatch(/MachineViolet/);
  });

  it("still names the product when the version is unknown", () => {
    const banner = versionBanner({
      compiled: true,
      execPath: "/opt/mv/MachineViolet",
      readFile: () => { throw new Error("nope"); },
    });
    expect(banner).toBe(`MachineViolet ${UNKNOWN_VERSION}`);
  });
});
