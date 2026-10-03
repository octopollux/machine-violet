/**
 * Model discovery against the codex app-server.
 *
 * Wraps `model/list` and translates each ModelInfo into the same
 * DiscoveredModel shape used by the rest of the connection store, so
 * the UI tier-picker doesn't need a separate code path for codex
 * connections.
 */
import type { DiscoveredModel } from "../../config/connections.js";
import type { CodexRpcClient } from "./rpc.js";
import type { ModelInfo, ModelListResult } from "./protocol.js";

export interface DiscoveredCodexModel extends DiscoveredModel {
  /** True when Codex flags this as the user's default model. */
  isDefault?: boolean;
  /** Reasoning-effort levels supported on this model. */
  supportedReasoningEfforts?: string[];
  /** Default reasoning effort returned by Codex. */
  defaultReasoningEffort?: string;
}

export async function listModels(client: CodexRpcClient, opts?: { limit?: number; includeHidden?: boolean }): Promise<DiscoveredCodexModel[]> {
  return (await listModelInfo(client, opts)).map(toDiscoveredModel);
}

/** Account availability and capabilities can span several opaque cursor pages. */
export async function listModelInfo(client: CodexRpcClient, opts?: { limit?: number; includeHidden?: boolean }): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await client.call<ModelListResult>("model/list", {
      limit: opts?.limit ?? 50,
      includeHidden: opts?.includeHidden ?? false,
      ...(cursor ? { cursor } : {}),
    });
    models.push(...result.data);
    cursor = result.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("Codex model/list repeated a pagination cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}

function toDiscoveredModel(m: ModelInfo): DiscoveredCodexModel {
  return {
    // id identifies the catalog row; model is the backend ID thread/start uses.
    id: m.model || m.id,
    ...(m.model && m.id !== m.model ? { aliases: [m.id] } : {}),
    displayName: m.displayName,
    available: !m.hidden,
    isDefault: m.isDefault,
    ...(m.supportedReasoningEfforts !== undefined
      ? { supportedReasoningEfforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) } : {}),
    defaultReasoningEffort: m.defaultReasoningEffort,
  };
}
