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
  it("is off by default (the test env sets no MV_RENDER_LOG, so no Profiler/timer is installed)", () => {
    expect(renderMeterEnabled()).toBe(false);
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
