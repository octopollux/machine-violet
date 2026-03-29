/**
 * Typed REST client for the engine server.
 *
 * Uses native fetch — no external HTTP library needed.
 * All request/response types come from @machine-violet/shared.
 */
import type {
  ListCampaignsResponse,
  StartCampaignResponse,
  ContributeRequest,
  CommitResponse,
  CommandRequest,
  ModalResponse as ModalResponseBody,
  SessionEndResponse,
  StateSnapshot,
} from "@machine-violet/shared";

export class ApiClient {
  private baseUrl: string;
  private playerId: string;

  constructor(baseUrl: string, playerId: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.playerId = playerId;
  }

  // --- Campaigns ---

  async listCampaigns(): Promise<ListCampaignsResponse> {
    return this.get("/campaigns");
  }

  async createCampaign(): Promise<StartCampaignResponse> {
    return this.post("/campaigns");
  }

  async startCampaign(id: string): Promise<StartCampaignResponse> {
    return this.post(`/campaigns/${encodeURIComponent(id)}/start`);
  }

  // --- Session ---

  async getState(): Promise<StateSnapshot> {
    return this.get("/session/state");
  }

  async contribute(text: string, type?: "action" | "dialogue" | "ooc"): Promise<{ turnId: string; contributionId: string }> {
    const body: ContributeRequest = { text, type };
    return this.post(`/session/turn/contribute?player=${encodeURIComponent(this.playerId)}`, body);
  }

  async commitTurn(): Promise<CommitResponse> {
    return this.post("/session/turn/commit");
  }

  async command(name: string, args?: string): Promise<{ ok: boolean }> {
    const body: CommandRequest = { args };
    return this.post(`/session/command/${encodeURIComponent(name)}`, body);
  }

  async respondToModal(id: string, value: string | number): Promise<{ ok: boolean }> {
    const body: ModalResponseBody = { value };
    return this.post(`/session/modal/${encodeURIComponent(id)}/respond`, body);
  }

  async patchSettings(settings: Record<string, unknown>): Promise<{ ok: boolean }> {
    return this.fetch("/session/settings", { method: "PATCH", body: settings });
  }

  async getCharacterSheet(name: string): Promise<{ name: string; content: string }> {
    return this.get(`/session/character/${encodeURIComponent(name)}`);
  }

  async getCompendium(): Promise<{ data: unknown }> {
    return this.get("/session/compendium");
  }

  async getNotes(): Promise<{ content: string }> {
    return this.get("/session/notes");
  }

  async saveNotes(content: string): Promise<{ ok: boolean }> {
    return this.fetch("/session/notes", { method: "PUT", body: { content } });
  }

  async getSettings(): Promise<{ config: unknown }> {
    return this.get("/session/settings");
  }

  async endSession(): Promise<SessionEndResponse> {
    return this.post("/session/end");
  }

  // --- Helpers ---

  private async get<T>(path: string): Promise<T> {
    return this.fetch(path, { method: "GET" });
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.fetch(path, { method: "POST", body });
  }

  private async fetch<T>(path: string, opts: { method: string; body?: unknown }): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method: opts.method,
    };
    if (opts.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }

    const response = await globalThis.fetch(url, init);
    if (!response.ok) {
      const text = await response.text();
      let message: string;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {
        message = text;
      }
      throw new ApiError(response.status, message);
    }
    return response.json() as Promise<T>;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
