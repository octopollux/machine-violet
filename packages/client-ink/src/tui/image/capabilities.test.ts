import {
  parseSixelFromDeviceAttributes,
  parseKittyGraphics,
  parseCellPixelSize,
  detectIterm2FromEnv,
  pickProtocol,
} from "./capabilities.js";

describe("parseSixelFromDeviceAttributes", () => {
  it("detects sixel (attribute 4) in a DA reply", () => {
    expect(parseSixelFromDeviceAttributes("\x1b[?62;4;6;9;22c")).toBe(true);
  });
  it("is false when attribute 4 is absent", () => {
    expect(parseSixelFromDeviceAttributes("\x1b[?62;22c")).toBe(false);
  });
  it("does not match a substring like 41 or 14", () => {
    expect(parseSixelFromDeviceAttributes("\x1b[?41;14c")).toBe(false);
  });
  it("is false on garbage", () => {
    expect(parseSixelFromDeviceAttributes("nonsense")).toBe(false);
  });
});

describe("parseKittyGraphics", () => {
  it("detects the OK response", () => {
    expect(parseKittyGraphics("\x1b_Gi=31;OK\x1b\\")).toBe(true);
  });
  it("is false on an error response", () => {
    expect(parseKittyGraphics("\x1b_Gi=31;ENODATA:bad\x1b\\")).toBe(false);
  });
  it("is false when no kitty response present", () => {
    expect(parseKittyGraphics("\x1b[?62;4c")).toBe(false);
  });
});

describe("parseCellPixelSize", () => {
  it("parses a 16t reply (height;width)", () => {
    expect(parseCellPixelSize("\x1b[6;20;10t")).toEqual({ width: 10, height: 20 });
  });
  it("returns null for the 14t terminal-size reply", () => {
    expect(parseCellPixelSize("\x1b[4;1012;1419t")).toBeNull();
  });
  it("returns null on absent/garbled reply", () => {
    expect(parseCellPixelSize("")).toBeNull();
    expect(parseCellPixelSize("\x1b[6;0;0t")).toBeNull();
  });
});

describe("detectIterm2FromEnv", () => {
  it("true for iTerm.app", () => {
    expect(detectIterm2FromEnv({ TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("true for recent WezTerm, false for old", () => {
    expect(detectIterm2FromEnv({ TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20230101-120000-abc" } as NodeJS.ProcessEnv)).toBe(true);
    expect(detectIterm2FromEnv({ TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: "20200101-120000-abc" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("false for plain xterm / Windows Terminal", () => {
    expect(detectIterm2FromEnv({ TERM_PROGRAM: "WindowsTerminal" } as NodeJS.ProcessEnv)).toBe(false);
    expect(detectIterm2FromEnv({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("pickProtocol", () => {
  const base = { kitty: false, iterm2: false, sixel: false, cellPixels: null };
  it("prefers kitty > iterm2 > sixel", () => {
    expect(pickProtocol({ ...base, kitty: true, iterm2: true, sixel: true })).toBe("kitty");
    expect(pickProtocol({ ...base, iterm2: true, sixel: true })).toBe("iterm2");
    expect(pickProtocol({ ...base, sixel: true })).toBe("sixel");
  });
  it("returns null when none supported", () => {
    expect(pickProtocol(base)).toBeNull();
  });
});
