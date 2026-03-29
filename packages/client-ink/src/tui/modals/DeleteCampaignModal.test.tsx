import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { DeleteCampaignModal } from "./DeleteCampaignModal.js";
import type { DeleteCampaignModalProps } from "./DeleteCampaignModal.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../themes/index.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import type { CampaignDeleteInfo } from "../../config/campaign-archive.js";

beforeEach(() => {
  resetPromptCache();
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

const sampleInfo: CampaignDeleteInfo = {
  campaignName: "Test Campaign",
  characterNames: ["Kael", "Lyra"],
  dmTurnCount: 42,
};

function defaultProps(overrides?: Partial<DeleteCampaignModalProps>): DeleteCampaignModalProps {
  return {
    theme: makeTheme(),
    width: 80,
    height: 24,
    info: sampleInfo,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

// Note: CenteredModal uses position="absolute", which ink-testing-library
// cannot capture in lastFrame(). We test callback behavior only.
// Arrow key escape sequences conflict with ESC handling in ink-testing-library,
// so we only test the default (Cancel) path and ESC dismissal.

describe("DeleteCampaignModal", () => {
  it("calls onCancel on Enter (default selection is Cancel)", () => {
    const onCancel = vi.fn();
    const { stdin } = render(<DeleteCampaignModal {...defaultProps({ onCancel })} />);
    stdin.write("\r");
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onCancel on ESC", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<DeleteCampaignModal {...defaultProps({ onCancel })} />);
    stdin.write("\u001B");
    await vi.waitFor(() => {
      expect(onCancel).toHaveBeenCalled();
    });
  });

  it("does not call onConfirm on default Enter", () => {
    const onConfirm = vi.fn();
    const { stdin } = render(<DeleteCampaignModal {...defaultProps({ onConfirm })} />);
    stdin.write("\r");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
