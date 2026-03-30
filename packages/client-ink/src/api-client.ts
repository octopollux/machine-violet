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
  ChoiceResponseRequest,
  SessionEndResponse,
  StateSnapshot,
} from "@machine-violet/shared";

export interface ApiKeyInfo {
  id: string;
  label: string;
  masked: string;
  source: "env" | "manual";
  addedAt?: string;
  tokenBudget?: number;
  isActive: boolean;
}

export interface ApiKeyListResponse {
  keys: ApiKeyInfo[];
  activeKeyId: string | null;
}

export interface KeyHealthResponse {
  id: string;
  status: "valid" | "invalid" | "error" | "rate_limited" | "checking";
  message: string;
  rateLimits: string | null;
}

export interface CampaignDeleteInfo {
  campaignName: string;
  characterNames: string[];
  dmTurnCount: number;
}

export interface ArchivedCampaignEntry {
  name: string;
  zipPath: string;
  archivedDate: string;
}

export interface ArchivedCampaignsResponse {
  archives: ArchivedCampaignEntry[];
}

export interface ConnectionInfo {
  id: string;
  provider: string;
  label: string;
  masked: string;
  baseUrl?: string;
  models: { id: string; displayName: string; available: boolean }[];
  source: string;
  addedAt: string;
}

export interface ConnectionsResponse {
  connections: ConnectionInfo[];
  tierAssignments: TierAssignmentsResponse;
}

export interface ConnectionHealthResponse {
  id: string;
  status: "valid" | "invalid" | "error" | "rate_limited";
  message: string;
  rateLimits?: { requestsRemaining: number; requestsLimit: number; tokensRemaining: number; tokensLimit: number };
}

export interface TierAssignmentEntry {
  connectionId: string;
  modelId: string;
}

export interface TierAssignmentsResponse {
  large: TierAssignmentEntry | null;
  medium: TierAssignmentEntry | null;
  small: TierAssignmentEntry | null;
}

export interface KnownModelInfo {
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  defaultTier: string;
  pricing: { input: number; output: number; cacheWrite: number; cacheRead: number };
  capabilities: { thinking: boolean; tools: boolean; streaming: boolean; caching: boolean };
}

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

  async contribute(
    text: string,
    opts?: { type?: "action" | "dialogue" | "ooc"; campaignId?: string; turnSeq?: number },
  ): Promise<{ turnId: string; contributionId: string }> {
    const body: ContributeRequest = { text, type: opts?.type, campaignId: opts?.campaignId, turnSeq: opts?.turnSeq };
    return this.post(`/session/turn/contribute?player=${encodeURIComponent(this.playerId)}`, body);
  }

  async commitTurn(): Promise<CommitResponse> {
    return this.post("/session/turn/commit");
  }

  async command(name: string, args?: string): Promise<{ ok: boolean }> {
    const body: CommandRequest = { args };
    return this.post(`/session/command/${encodeURIComponent(name)}`, body);
  }

  async respondToChoice(value: string): Promise<{ ok: boolean }> {
    const body: ChoiceResponseRequest = { value };
    return this.post("/session/choice/respond", body);
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

  async cyclePlayer(): Promise<{ activePlayerIndex: number; character: string }> {
    return this.post("/session/player/cycle");
  }

  async getCost(): Promise<{ breakdown: unknown; formatted: string }> {
    return this.get("/session/cost");
  }

  async endSession(): Promise<SessionEndResponse> {
    return this.post("/session/end");
  }

  // --- Management (pre-session) ---

  async listKeys(): Promise<ApiKeyListResponse> {
    return this.get("/manage/keys");
  }

  async addKey(key: string, label?: string): Promise<ApiKeyListResponse> {
    return this.post("/manage/keys", { key, label });
  }

  async removeKey(id: string): Promise<ApiKeyListResponse> {
    return this.fetch(`/manage/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async activateKey(id: string): Promise<{ ok: boolean; activeKeyId: string }> {
    return this.post(`/manage/keys/${encodeURIComponent(id)}/activate`);
  }

  async checkKeyHealth(id: string): Promise<KeyHealthResponse> {
    return this.post(`/manage/keys/${encodeURIComponent(id)}/check`);
  }

  // --- Connections (multi-provider) ---

  async listConnections(): Promise<ConnectionsResponse> {
    return this.get("/manage/connections");
  }

  async addConnection(provider: string, apiKey: string, label?: string, baseUrl?: string): Promise<ConnectionsResponse> {
    return this.post("/manage/connections", { provider, apiKey, label, baseUrl });
  }

  async removeConnection(id: string): Promise<ConnectionsResponse> {
    return this.fetch(`/manage/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async checkConnection(id: string): Promise<ConnectionHealthResponse> {
    return this.post(`/manage/connections/${encodeURIComponent(id)}/check`);
  }

  async getTierAssignments(): Promise<{ tierAssignments: TierAssignmentsResponse }> {
    return this.get("/manage/tiers");
  }

  async setTierAssignments(assignments: Partial<TierAssignmentsResponse>): Promise<{ tierAssignments: TierAssignmentsResponse }> {
    return this.fetch("/manage/tiers", { method: "PUT", body: assignments });
  }

  async listKnownModels(): Promise<{ models: Record<string, KnownModelInfo> }> {
    return this.get("/manage/models");
  }

  async getCampaignDeleteInfo(id: string): Promise<CampaignDeleteInfo> {
    return this.get(`/manage/campaigns/${encodeURIComponent(id)}/delete-info`);
  }

  async archiveCampaign(id: string): Promise<{ ok: boolean }> {
    return this.post(`/manage/campaigns/${encodeURIComponent(id)}/archive`);
  }

  async deleteCampaign(id: string): Promise<{ ok: boolean }> {
    return this.fetch(`/manage/campaigns/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listArchivedCampaigns(): Promise<ArchivedCampaignsResponse> {
    return this.get("/manage/campaigns/archived");
  }

  async restoreArchivedCampaign(name: string, zipPath?: string): Promise<{ ok: boolean }> {
    return this.post(`/manage/campaigns/archived/${encodeURIComponent(name)}/restore`, zipPath ? { zipPath } : undefined);
  }

  async getDiscordSettings(): Promise<{ enabled: boolean | null }> {
    return this.get("/manage/discord");
  }

  async setDiscordSettings(enabled: boolean): Promise<{ enabled: boolean }> {
    return this.fetch("/manage/discord", { method: "PUT", body: { enabled } });
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
