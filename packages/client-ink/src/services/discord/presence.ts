import { randomUUID } from "node:crypto";
import { DiscordIPCClient } from "./ipc-client.js";
import { Opcode, type DiscordActivity, type PresenceConfig } from "./types.js";

/** Discord application ID registered on the Developer Portal. */
const DISCORD_CLIENT_ID = "1485029427468435646";

const ASSET_KEY_LOGO = "mv-logo";

/**
 * High-level Discord Rich Presence manager.
 *
 * Silently no-ops when Discord is unavailable.
 * All public methods are safe to call at any time.
 */
export class DiscordPresence {
  private ipc: DiscordIPCClient | null = null;
  private currentActivity: DiscordActivity = {};

  /** Whether the IPC connection is live. */
  get active(): boolean {
    return this.ipc?.connected ?? false;
  }

  /** Connect to Discord and set the initial presence. */
  async start(config: PresenceConfig): Promise<void> {
    const client = new DiscordIPCClient();
    const connected = await client.connect();
    if (!connected) return;

    const clientId = config.clientId || DISCORD_CLIENT_ID;
    const ready = await client.handshake(clientId);
    if (!ready) {
      await client.close();
      return;
    }

    this.ipc = client;
    this.currentActivity = {
      details: "Starting a new adventure...",
      state: `${config.campaignName} \u2014 ${config.dmPersona}`,
      timestamps: { start: Math.floor(Date.now() / 1000) },
      assets: { large_image: ASSET_KEY_LOGO, large_text: "Machine Violet" },
    };

    await this.setActivity();
  }

  /** Update just the details line (the punchy status string). */
  async updateDetails(details: string): Promise<void> {
    if (!this.active) return;
    this.currentActivity.details = details;
    await this.setActivity();
  }

  /** Clear presence and close the IPC connection. */
  async stop(): Promise<void> {
    if (this.ipc) {
      // Clear activity before closing
      try {
        await this.ipc.send(Opcode.FRAME, {
          cmd: "SET_ACTIVITY",
          args: { pid: process.pid, activity: null },
          nonce: randomUUID(),
        });
      } catch {
        // Best-effort
      }
      await this.ipc.close();
      this.ipc = null;
    }
    this.currentActivity = {};
  }

  private async setActivity(): Promise<void> {
    if (!this.ipc) return;
    await this.ipc.send(Opcode.FRAME, {
      cmd: "SET_ACTIVITY",
      args: {
        pid: process.pid,
        activity: this.currentActivity,
      },
      nonce: randomUUID(),
    });
  }
}
