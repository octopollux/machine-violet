import { describe, it, expect } from "vitest";
import { classifyPath } from "../src/server/watcher.js";

describe("privileged co-DM visibility", () => {
  it("keeps queue, receipts and startup jobs separate from player transcripts", () => {
    for (const path of ["state/co-dm-experiment.json", "state/co-dm-operations.json", "state/co-dm-completion.json", "state/startup.json", "state/portrait-jobs.json", "state/image-jobs/scene-1.json", "state/provider-journals/scope-hash/0.json", "state\\provider-journals\\scope-hash\\1.json"]) {
      expect(classifyPath(path)).toBe("co-dm-private");
    }
    expect(classifyPath("state/foreground-pending.json")).toBe("co-dm-private");
    expect(classifyPath("campaign/scenes/001-opening/transcript.md")).toBe("transcript");
    expect(classifyPath(".debug/session/context/co_dm-001.json")).toBe("context-dump");
  });
});
