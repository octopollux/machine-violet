import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { ConnectionsArea } from "./ConnectionsArea.js";
import type { ConnectionsAreaProps } from "./ConnectionsArea.js";
import type { ConnectionInfo } from "../../api-client.js";
import { resetThemeCache, resolveTheme, BUILTIN_DEFINITIONS } from "../../tui/themes/index.js";

const DOWN = "[B";
const ENTER = "\r";
const ESC = "";

beforeEach(() => {
  resetThemeCache();
});

function makeTheme() {
  const def = BUILTIN_DEFINITIONS["gothic"] ?? Object.values(BUILTIN_DEFINITIONS)[0];
  return resolveTheme(def, "exploration", "#8888aa");
}

function conn(overrides?: Partial<ConnectionInfo>): ConnectionInfo {
  return {
    id: "conn-1",
    provider: "anthropic",
    label: "Anthropic",
    masked: "sk-ant-...abcd",
    models: [
      { id: "claude-large", displayName: "Claude Large", available: true },
      { id: "claude-small", displayName: "Claude Small", available: true },
    ],
    source: "manual",
    addedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function defaultProps(overrides?: Partial<ConnectionsAreaProps>): ConnectionsAreaProps {
  return {
    theme: makeTheme(),
    initialScreen: "list",
    connections: [],
    tierAssignments: { large: null, medium: null, small: null },
    imageAssignment: null,
    healthResults: {},
    knownModels: {},
    knownImageModels: {},
    tierDefaults: {},
    onAddConnection: vi.fn(async () => conn()),
    onUpdateConnectionKey: vi.fn(async () => undefined),
    onRemoveConnection: vi.fn(async () => undefined),
    onCheckHealth: vi.fn(async (id: string) => ({ id, status: "valid" as const, message: "Valid" })),
    onSetTiers: vi.fn(async () => undefined),
    onStartChatGptLogin: vi.fn(async () => ({ loginId: "l1", authUrl: "https://auth.example/x" })),
    onPollChatGptLogin: vi.fn(async () => ({ status: "pending" as const })),
    onCancelChatGptLogin: vi.fn(async () => ({ ok: true })),
    onRefreshConnections: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

async function press(rendered: ReturnType<typeof render>, key: string) {
  rendered.stdin.write(key);
  await new Promise((r) => setTimeout(r, 20));
}

describe("ConnectWizard provider picker", () => {
  it("asks the Connect to AI question and leads with ChatGPT as recommended", () => {
    const rendered = render(<ConnectionsArea {...defaultProps({ initialScreen: "wizard" })} />);
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Connect to AI");
    expect(frame).toContain("How will Machine Violet connect to AI?");
    expect(frame).toContain("recommended");
    // ChatGPT sign-in is the first (pre-selected) row.
    const selected = frame.split("\n").find((l) => l.includes("◆")) ?? "";
    expect(selected).toContain("OpenAI (ChatGPT)");
    expect(selected).toContain("Sign in with your ChatGPT subscription");
  });

  it("offers every visible provider by display name, never raw provider ids", () => {
    const rendered = render(<ConnectionsArea {...defaultProps({ initialScreen: "wizard" })} />);
    const frame = rendered.lastFrame() ?? "";
    for (const name of ["Anthropic", "OpenAI (API key)", "Google Gemini", "OpenRouter", "Custom endpoint"]) {
      expect(frame).toContain(name);
    }
    expect(frame).not.toContain("openai-apikey");
    expect(frame).not.toContain("openai-chatgpt");
  });

  it("does not offer xAI while it is gated pending the Grok 4.6 retest (#749)", () => {
    const rendered = render(<ConnectionsArea {...defaultProps({ initialScreen: "wizard" })} />);
    expect(rendered.lastFrame()).not.toContain("xAI");
  });

  it("marks the custom endpoint as experimental and untested", () => {
    const rendered = render(<ConnectionsArea {...defaultProps({ initialScreen: "wizard" })} />);
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("experimental");
    expect(frame).toContain("untested");
  });

  it("exits to the caller when Esc is pressed at the wizard root", async () => {
    const onBack = vi.fn();
    const rendered = render(<ConnectionsArea {...defaultProps({ initialScreen: "wizard", onBack })} />);
    await press(rendered, ESC);
    expect(onBack).toHaveBeenCalled();
  });
});

describe("ConnectWizard key entry", () => {
  async function openKeyScreen(props?: Partial<ConnectionsAreaProps>) {
    const rendered = render(<ConnectionsArea {...defaultProps({ initialScreen: "wizard", ...props })} />);
    // ChatGPT → OpenAI (API key): one Down, then Enter.
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    await vi.waitFor(() => {
      expect(rendered.lastFrame()).toContain("Paste your OpenAI (API key) API key");
    });
    return rendered;
  }

  it("masks the key while typing instead of echoing it in plaintext", async () => {
    const rendered = await openKeyScreen();
    for (const ch of "sk-secret-123456") rendered.stdin.write(ch);
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? "";
      expect(frame).not.toContain("sk-secret-123456");
      expect(frame).toContain("•");
      // Last four characters stay visible for verification.
      expect(frame).toContain("3456");
    });
  });

  it("shows where to find a key", async () => {
    const rendered = await openKeyScreen();
    expect(rendered.lastFrame()).toContain("platform.openai.com/api-keys");
  });

  it("refuses Enter on an empty key with an inline message instead of silence", async () => {
    const onAddConnection = vi.fn(async () => conn());
    const rendered = await openKeyScreen({ onAddConnection });
    await press(rendered, ENTER);
    expect(onAddConnection).not.toHaveBeenCalled();
    expect(rendered.lastFrame()).toContain("Paste your OpenAI (API key) API key first.");
  });
});

describe("ConnectWizard validate-on-submit", () => {
  async function submitKey(props: Partial<ConnectionsAreaProps>) {
    const rendered = render(<ConnectionsArea {...defaultProps({ initialScreen: "wizard", ...props })} />);
    await press(rendered, DOWN); // OpenAI (API key)
    await press(rendered, ENTER);
    for (const ch of "sk-test-key") rendered.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 20));
    await press(rendered, ENTER);
    return rendered;
  }

  it("verifies the key and reports success only after the health check passes", async () => {
    const added = conn({ id: "new-1", provider: "openai-apikey", label: "OpenAI" });
    const onAddConnection = vi.fn(async () => added);
    const onCheckHealth = vi.fn(async (id: string) => ({ id, status: "valid" as const, message: "Valid" }));
    const rendered = await submitKey({ onAddConnection, onCheckHealth });
    await vi.waitFor(() => {
      expect(onAddConnection).toHaveBeenCalledWith("openai-apikey", "sk-test-key", undefined);
      expect(onCheckHealth).toHaveBeenCalledWith("new-1");
      expect(rendered.lastFrame()).toContain("✔ Connected to OpenAI");
    });
  });

  it("removes the connection and bounces back to the key screen on an invalid key", async () => {
    const added = conn({ id: "new-1", provider: "openai-apikey", label: "OpenAI" });
    const onAddConnection = vi.fn(async () => added);
    const onRemoveConnection = vi.fn(async () => undefined);
    const onCheckHealth = vi.fn(async (id: string) => ({ id, status: "invalid" as const, message: "Invalid API key" }));
    const rendered = await submitKey({ onAddConnection, onRemoveConnection, onCheckHealth });
    await vi.waitFor(() => {
      expect(onRemoveConnection).toHaveBeenCalledWith("new-1");
      const frame = rendered.lastFrame() ?? "";
      // Back on the key screen with the provider's actual error.
      expect(frame).toContain("Invalid API key");
      expect(frame).toContain("Paste your OpenAI (API key) API key");
    });
  });

  it("surfaces a server rejection instead of pretending the add worked", async () => {
    const onAddConnection = vi.fn(async () => {
      throw new Error("Unknown provider: nope.");
    });
    const rendered = await submitKey({ onAddConnection });
    await vi.waitFor(() => {
      expect(rendered.lastFrame()).toContain("Unknown provider: nope.");
    });
  });

  it("offers to switch when another connection is already in use", async () => {
    const active = conn({ id: "old-1", provider: "anthropic", label: "Anthropic" });
    const added = conn({ id: "new-1", provider: "openai-apikey", label: "OpenAI" });
    const onAddConnection = vi.fn(async () => added);
    const onSetTiers = vi.fn(async () => undefined);
    const rendered = await submitKey({
      connections: [active, added],
      tierAssignments: { large: { connectionId: "old-1", modelId: "claude-large" }, medium: null, small: null },
      tierDefaults: { "openai-apikey": { large: "claude-large", medium: "claude-small", small: "claude-small" } },
      onAddConnection,
      onSetTiers,
    });
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? "";
      expect(frame).toContain("Your game is currently set up to use Anthropic.");
      expect(frame).toContain("Enter switch to OpenAI");
      expect(frame).toContain("K keep Anthropic");
    });
    await press(rendered, ENTER); // switch
    await vi.waitFor(() => {
      expect(onSetTiers).toHaveBeenCalledWith(expect.objectContaining({
        large: { connectionId: "new-1", modelId: "claude-large" },
        medium: { connectionId: "new-1", modelId: "claude-small" },
        small: { connectionId: "new-1", modelId: "claude-small" },
        imageAssignment: null,
      }));
    });
  });
});

describe("ConnectWizard ChatGPT sign-in hints", () => {
  async function openChatGpt(props?: Partial<ConnectionsAreaProps>) {
    const rendered = render(<ConnectionsArea {...defaultProps({ initialScreen: "wizard", ...props })} />);
    await press(rendered, ENTER); // ChatGPT is the pre-selected first row
    return rendered;
  }

  it("offers Esc (and never Enter) while the sign-in is pending", async () => {
    const rendered = await openChatGpt();
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? "";
      expect(frame).toContain("Waiting for browser authentication");
      expect(frame).toContain("Esc cancel");
      expect(frame).not.toContain("Enter");
    });
  });

  it("offers Esc only when the sign-in was cancelled", async () => {
    const rendered = await openChatGpt({
      onPollChatGptLogin: vi.fn(async () => ({ status: "cancelled" as const })),
    });
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? "";
      expect(frame).toContain("Sign-in cancelled.");
      expect(frame).toContain("Esc back");
      expect(frame).not.toContain("Enter");
    });
  });

  it("offers Esc only when the sign-in failed", async () => {
    const rendered = await openChatGpt({
      onPollChatGptLogin: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
    });
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? "";
      expect(frame).toContain("Sign-in failed: boom");
      expect(frame).toContain("Esc back");
      expect(frame).not.toContain("Enter");
    });
  });

  it("offers Enter only (no Esc) after a verified successful sign-in", async () => {
    const rendered = await openChatGpt({
      onPollChatGptLogin: vi.fn(async () => ({
        status: "success" as const,
        connectionId: "cg-1",
        email: "q@example.com",
        planType: "plus",
      })),
    });
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? "";
      expect(frame).toContain("✔ Signed in as q@example.com (plus)");
      expect(frame).toContain("Enter continue");
      expect(frame).not.toContain("Esc");
    });
  });
});

describe("ConnectionsList", () => {
  it("renders connections with display names, an in-use marker, and the add/advanced rows", () => {
    const rendered = render(<ConnectionsArea {...defaultProps({
      connections: [conn({ id: "a-1", provider: "anthropic", label: "Anthropic" })],
      tierAssignments: { large: { connectionId: "a-1", modelId: "claude-large" }, medium: null, small: null },
    })} />);
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("Connect to AI");
    expect(frame).toContain("Anthropic");
    expect(frame).toContain("in use");
    expect(frame).toContain("Add connection");
    expect(frame).toContain("Model assignments");
    expect(frame).toContain("advanced");
  });

  it("invites the player to add a connection when none exist", () => {
    const rendered = render(<ConnectionsArea {...defaultProps()} />);
    const frame = rendered.lastFrame() ?? "";
    expect(frame).toContain("No AI connection yet — add one to play.");
    // No advanced row without a connection to scope it to.
    expect(frame).not.toContain("Model assignments");
  });
});

describe("ConnectionDetail", () => {
  async function openDetail(props?: Partial<ConnectionsAreaProps>) {
    const rendered = render(<ConnectionsArea {...defaultProps({
      connections: [conn()],
      ...props,
    })} />);
    await press(rendered, ENTER); // first row = the connection
    await vi.waitFor(() => {
      expect(rendered.lastFrame()).toContain("Provider");
    });
    return rendered;
  }

  it("requires a second Enter to confirm deletion", async () => {
    const onRemoveConnection = vi.fn(async () => undefined);
    const rendered = await openDetail({ onRemoveConnection });
    // Rows: Use / Check / Delete.
    await press(rendered, DOWN);
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    expect(onRemoveConnection).not.toHaveBeenCalled();
    expect(rendered.lastFrame()).toContain("press Enter again to confirm");
    await press(rendered, ENTER);
    await vi.waitFor(() => {
      expect(onRemoveConnection).toHaveBeenCalledWith("conn-1");
    });
  });

  it("offers Fix connection when the check failed, and re-enters the key in place", async () => {
    const onUpdateConnectionKey = vi.fn(async () => undefined);
    const onCheckHealth = vi.fn(async (id: string) => ({ id, status: "valid" as const, message: "Valid" }));
    const rendered = await openDetail({
      healthResults: { "conn-1": { id: "conn-1", status: "invalid", message: "Invalid API key" } },
      onUpdateConnectionKey,
      onCheckHealth,
    });
    const frame = () => rendered.lastFrame() ?? "";
    expect(frame()).toContain("Fix connection");
    expect(frame()).toContain("re-enter your API key");

    await press(rendered, ENTER); // Fix leads the actions when broken
    await vi.waitFor(() => {
      expect(frame()).toContain("Paste a new Anthropic API key");
      expect(frame()).toContain("model choices are kept");
    });
    for (const ch of "sk-fixed-key") rendered.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 20));
    await press(rendered, ENTER);
    await vi.waitFor(() => {
      expect(onUpdateConnectionKey).toHaveBeenCalledWith("conn-1", "sk-fixed-key");
      expect(onCheckHealth).toHaveBeenCalledWith("conn-1");
      // Verified — back on the detail screen.
      expect(frame()).toContain("Provider");
    });
  });

  it("keeps the player on the fix screen with the provider's error when the new key is invalid", async () => {
    const onCheckHealth = vi.fn(async (id: string) => ({ id, status: "invalid" as const, message: "Invalid API key" }));
    const rendered = await openDetail({
      healthResults: { "conn-1": { id: "conn-1", status: "invalid", message: "Invalid API key" } },
      onCheckHealth,
    });
    await press(rendered, ENTER); // Fix
    await vi.waitFor(() => expect(rendered.lastFrame()).toContain("Paste a new Anthropic API key"));
    for (const ch of "sk-still-bad") rendered.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 20));
    await press(rendered, ENTER);
    await vi.waitFor(() => {
      const frame = rendered.lastFrame() ?? "";
      expect(frame).toContain("Invalid API key");
      expect(frame).toContain("Paste a new Anthropic API key");
    });
  });

  it("fixes a broken ChatGPT connection by re-running the sign-in flow", async () => {
    const rendered = await openDetail({
      connections: [conn({ id: "cg-1", provider: "openai-chatgpt", label: "ChatGPT (q@example.com)" })],
      healthResults: { "cg-1": { id: "cg-1", status: "invalid", message: "Not signed in" } },
    });
    const frame = () => rendered.lastFrame() ?? "";
    expect(frame()).toContain("Fix connection");
    expect(frame()).toContain("sign in again");
    await press(rendered, ENTER);
    await vi.waitFor(() => {
      // The ChatGPT OAuth screen took over (pending on the mocked start/poll).
      expect(frame()).toMatch(/Starting the sign-in flow|Sign in by opening this URL/);
    });
  });

  it("explains why env connections cannot be deleted instead of silently refusing", async () => {
    const onRemoveConnection = vi.fn(async () => undefined);
    const rendered = await openDetail({
      connections: [conn({ id: "env-anthropic", source: "env", label: "Anthropic (env)" })],
      onRemoveConnection,
    });
    expect(rendered.lastFrame()).toContain("set by an environment variable");
    await press(rendered, DOWN);
    await press(rendered, DOWN);
    await press(rendered, ENTER);
    expect(onRemoveConnection).not.toHaveBeenCalled();
  });

  it("offers no Fix action while the connection is healthy", async () => {
    const rendered = await openDetail({
      healthResults: { "conn-1": { id: "conn-1", status: "valid", message: "Valid" } },
    });
    expect(rendered.lastFrame()).not.toContain("Fix connection");
  });

  it("applies the provider's default models when Use this connection is chosen", async () => {
    const onSetTiers = vi.fn(async () => undefined);
    const rendered = await openDetail({
      connections: [conn()],
      tierAssignments: { large: null, medium: null, small: null },
      tierDefaults: { anthropic: { large: "claude-large", medium: "claude-small", small: "claude-small" } },
      onSetTiers,
    });
    await press(rendered, ENTER); // "Use this connection"
    await vi.waitFor(() => {
      expect(onSetTiers).toHaveBeenCalledWith({
        large: { connectionId: "conn-1", modelId: "claude-large" },
        medium: { connectionId: "conn-1", modelId: "claude-small" },
        small: { connectionId: "conn-1", modelId: "claude-small" },
        imageAssignment: null,
      });
    });
  });
});
