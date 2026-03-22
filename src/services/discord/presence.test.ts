import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordPresence } from "./presence.js";

// Mock the ipc-client module with a controllable class
const mockConnect = vi.fn<() => Promise<boolean>>();
const mockHandshake = vi.fn<() => Promise<boolean>>();
const mockSend = vi.fn<(op: number, payload: object) => Promise<void>>();
const mockClose = vi.fn<() => Promise<void>>();
let mockConnected = false;

vi.mock("./ipc-client.js", () => ({
  DiscordIPCClient: class MockIPCClient {
    get connected() { return mockConnected; }
    connect = mockConnect;
    handshake = mockHandshake;
    send = mockSend;
    close = mockClose;
  },
  encodeFrame: vi.fn(),
  getPipePath: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockConnected = false;
  mockConnect.mockResolvedValue(false);
  mockHandshake.mockResolvedValue(false);
  mockSend.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
});

describe("DiscordPresence", () => {
  it("starts and sets initial activity when Discord is available", async () => {
    mockConnect.mockResolvedValue(true);
    mockHandshake.mockResolvedValue(true);
    mockConnected = true;

    const presence = new DiscordPresence();
    await presence.start({ clientId: "test-id", campaignName: "Shadows of Eldoria", dmPersona: "The Narrator" });

    expect(mockConnect).toHaveBeenCalled();
    expect(mockHandshake).toHaveBeenCalledWith("test-id");
    expect(mockSend).toHaveBeenCalled();

    // Check the SET_ACTIVITY payload
    const [, payload] = mockSend.mock.calls[0];
    const frame = payload as Record<string, unknown>;
    expect(frame).toHaveProperty("cmd", "SET_ACTIVITY");
    const args = frame.args as Record<string, unknown>;
    const activity = args.activity as Record<string, unknown>;
    expect(activity.state).toBe("Shadows of Eldoria \u2014 The Narrator");
    expect(activity.details).toBe("Starting a new adventure...");
    expect(activity.timestamps).toHaveProperty("start");
    expect(activity.assets).toHaveProperty("large_image", "mv-logo");
  });

  it("silently no-ops when Discord is not available", async () => {
    mockConnect.mockResolvedValue(false);

    const presence = new DiscordPresence();
    await presence.start({ clientId: "test-id", campaignName: "Test", dmPersona: "DM" });

    expect(mockConnect).toHaveBeenCalled();
    expect(mockHandshake).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(presence.active).toBe(false);
  });

  it("silently no-ops when handshake fails", async () => {
    mockConnect.mockResolvedValue(true);
    mockHandshake.mockResolvedValue(false);

    const presence = new DiscordPresence();
    await presence.start({ clientId: "test-id", campaignName: "Test", dmPersona: "DM" });

    expect(mockClose).toHaveBeenCalled();
    expect(presence.active).toBe(false);
  });

  it("updateDetails is a no-op when not connected", async () => {
    const presence = new DiscordPresence();
    await presence.updateDetails("testing the void");
    expect(presence.active).toBe(false);
  });

  it("stop is safe to call when not connected", async () => {
    const presence = new DiscordPresence();
    await presence.stop();
    expect(presence.active).toBe(false);
  });
});
