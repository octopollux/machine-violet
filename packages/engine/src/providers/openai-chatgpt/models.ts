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
  const result = await client.call<ModelListResult>("model/list", {
    limit: opts?.limit ?? 50,
    includeHidden: opts?.includeHidden ?? false,
  });
  return result.data.map(toDiscoveredModel);
}

function toDiscoveredModel(m: ModelInfo): DiscoveredCodexModel {
  return {
    id: m.id,
    displayName: m.displayName,
    available: !m.hidden,
    isDefault: m.isDefault,
    supportedReasoningEfforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    defaultReasoningEffort: m.defaultReasoningEffort,
  };
}
