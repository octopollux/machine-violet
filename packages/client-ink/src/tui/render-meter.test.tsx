import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderMeterLogPath, renderMeterEnabled, RenderZone } from "./render-meter.js";

describe("renderMeterLogPath", () => {
  it("returns null when MV_RENDER_LOG is unset or empty", () => {
    expect(renderMeterLogPath({})).toBeNull();
    expect(renderMeterLogPath({ MV_RENDER_LOG: "" })).toBeNull();
  });

  it("maps truthy flags to the default tmpdir sink", () => {
    const def = join(tmpdir(), "machine-violet", "render-meter.jsonl");
    for (const v of ["1", "true", "on", "yes"]) {
      expect(renderMeterLogPath({ MV_RENDER_LOG: v })).toBe(def);
    }
  });

  it("treats any other value as an explicit path", () => {
    expect(renderMeterLogPath({ MV_RENDER_LOG: "/var/log/rm.jsonl" })).toBe("/var/log/rm.jsonl");
  });
});

describe("renderMeterEnabled", () => {
  it("matches the env the singleton read at import — deterministic whether or not MV_RENDER_LOG is set", () => {
    // The meter singleton reads process.env ONCE at module import, so a fixed
    // `false` expectation is wrong in any shell/CI that has MV_RENDER_LOG set
    // (e.g. a render-metering session). Derive the expectation from that same
    // env instead so the assertion holds either way (Copilot #701).
    expect(renderMeterEnabled()).toBe(renderMeterLogPath(process.env) !== null);
  });
});

describe("RenderZone", () => {
  it("is a transparent passthrough when disabled — children render unchanged", () => {
    const { lastFrame } = render(
      <RenderZone id="test">
        <Text>hello-zone</Text>
      </RenderZone>,
    );
    expect(lastFrame()).toContain("hello-zone");
  });
});
