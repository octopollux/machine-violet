/**
 * Frontend-local controller for Discord rich presence.
 *
 * The engine is shared across multiple frontends; opting in to Discord is a
 * per-frontend setting. This controller listens for `discord:presence` events
 * from the engine and forwards them to the local Discord IPC iff the user has
 * opted in on this frontend.
 */
import type { ServerEvent } from "@machine-violet/shared";
import { DiscordPresence } from "./presence.js";

interface SessionInfo { campaignName: string; dmPersona: string }

export class DiscordPresenceController {
  private presence: DiscordPresence | null = null;
  private session: SessionInfo | null = null;
  private starting = false;
  /** Bumped by anything that should cancel an in-flight ensureStarted() —
   *  shutdown(), disable(), or a `discord:presence` stop event. */
  private generation = 0;

  /** Dispatch a server event. `enabled` is the current frontend-local opt-in. */
  handle(event: ServerEvent, enabled: boolean): void {
    if (event.type !== "discord:presence") return;
    const data = event.data;

    if (data.action === "start") {
      this.session = { campaignName: data.campaignName, dmPersona: data.dmPersona };
      if (enabled) void this.ensureStarted();
    } else if (data.action === "update") {
      if (enabled && this.presence?.active) void this.presence.updateDetails(data.details);
    } else if (data.action === "stop") {
      this.session = null;
      void this.shutdown();
    }
  }

  /** Call when the frontend's opt-in flips to true mid-session. */
  enable(): void {
    if (this.session) void this.ensureStarted();
  }

  /** Call when the frontend's opt-in flips to false. */
  disable(): void {
    void this.shutdown();
  }

  /** Call from app teardown. */
  async shutdown(): Promise<void> {
    this.generation++;
    if (this.presence) {
      const p = this.presence;
      this.presence = null;
      await p.stop();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.presence || this.starting || !this.session) return;
    this.starting = true;
    const startedAt = this.generation;
    const session = this.session;
    try {
      const next = new DiscordPresence();
      await next.start({
        clientId: "",
        campaignName: session.campaignName,
        dmPersona: session.dmPersona,
      });
      // Race guard: if shutdown()/disable() ran while start() was awaiting,
      // generation has advanced. Tear down what we just started instead of
      // re-attaching it.
      if (this.generation !== startedAt || !next.active) {
        if (next.active) await next.stop();
        return;
      }
      this.presence = next;
    } finally {
      this.starting = false;
    }
  }
}
