/**
 * Per-tier provider resolution.
 *
 * Translates a {@link ConnectionStore} into a `Record<ModelTier, TierProvider>`
 * — the {provider, model} pair each tier should use. The DM runs on `large`;
 * subagents pick `medium` or `small` per task. Resolving all three up front
 * means a heterogeneous setup (e.g. Large=OpenAI, Medium/Small=Anthropic)
 * routes each call to the right vendor without ever sending an Anthropic
 * model ID through an OpenAI client.
 *
 * Used by both {@link SessionManager} (gameplay sessions) and
 * {@link SetupSession} (campaign creation, before a GameEngine exists).
 */
import { createProviderFromConnection } from "../providers/index.js";
import type { LLMProvider, TierProvider } from "../providers/types.js";
import type { ModelTier } from "@machine-violet/shared/types/engine.js";
import type { ConnectionStore } from "./connections.js";
import { getTierProvider } from "./connections.js";
import { getModel, getEffortConfig } from "./models.js";
import type { EffortLevel } from "./models.js";

/**
 * Build a {provider, model} pair for each tier from the connection store.
 *
 * For each tier:
 *   - If the store has a tier assignment, the connection's provider is
 *     instantiated (cached per connection ID, so two tiers sharing a
 *     connection share the underlying client) and paired with the assigned
 *     model ID.
 *   - Otherwise the `fallbackProvider` thunk is invoked and paired with
 *     `getModel(tier)`. The thunk is lazy so configurations that fully
 *     cover all three tiers via assignments don't pay the cost of
 *     constructing an unused fallback client.
 *
 * @param connStore  Effective connection store (env + manual + auto-resolved tier assignments).
 * @param fallbackProvider  Thunk that returns the fallback provider — typically `createAnthropicProvider()`.
 *                          Called at most once across all three tier resolutions.
 */
export interface TierProviderResolution {
  tiers: Record<ModelTier, TierProvider>;
  coDm: TierProvider;
  coDmEffort: EffortLevel | null;
  /** Explicit image-model override paired to the Large-tier connection. */
  imageModel?: string;
  /**
   * Map of connectionId → provider instance for every connection that
   * actually backs an assigned tier. Used by callers (e.g. session-manager)
   * that need to find a provider by connection id for non-tier operations
   * like usage queries. The fallback provider is intentionally absent —
   * it isn't associated with a connection.
   */
  byConnectionId: Map<string, LLMProvider>;
}

export function buildTierProviders(
  connStore: ConnectionStore,
  fallbackProvider: () => LLMProvider,
  configDir?: string,
): Record<ModelTier, TierProvider> {
  return buildTierProvidersWithCache(connStore, fallbackProvider, configDir).tiers;
}

/**
 * Variant of {@link buildTierProviders} that also returns the
 * connectionId → provider cache. Callers that need the raw map (for
 * dispose / usage lookups) use this; older callers keep the cleaner
 * legacy return shape.
 *
 * `configDir` is forwarded to {@link createProviderFromConnection} so
 * `openai-chatgpt` connections can back their token store on disk and
 * persist refreshed access_tokens.
 */
export function buildTierProvidersWithCache(
  connStore: ConnectionStore,
  fallbackProvider: () => LLMProvider,
  configDir?: string,
): TierProviderResolution {
  const providerCache = new Map<string, LLMProvider>();
  const getProviderForConnId = (connId: string): LLMProvider => {
    let p = providerCache.get(connId);
    if (!p) {
      const conn = connStore.connections.find((c) => c.id === connId);
      if (!conn) throw new Error(`Connection not found: ${connId}`);
      p = createProviderFromConnection(conn, { configDir });
      providerCache.set(connId, p);
    }
    return p;
  };

  let fallback: LLMProvider | undefined;
  const getFallback = (): LLMProvider => {
    if (!fallback) fallback = fallbackProvider();
    return fallback;
  };

  const resolveTier = (tier: ModelTier): TierProvider => {
    const assignment = getTierProvider(connStore, tier);
    if (assignment) {
      return { provider: getProviderForConnId(assignment.connection.id), model: assignment.modelId };
    }
    return { provider: getFallback(), model: getModel(tier) };
  };

  const tiers = {
      large: resolveTier("large"),
      medium: resolveTier("medium"),
      small: resolveTier("small"),
  };
  const assignment = connStore.coDmAssignment;
  const selected = assignment ?? connStore.tierAssignments.large;
  const discovered = selected ? connStore.connections.find(c => c.id === selected.connectionId)?.models
    .find(m => m.id === selected.modelId || m.aliases?.includes(selected.modelId)) : undefined;
  const coDm = assignment
    ? { provider: getProviderForConnId(assignment.connectionId), model: discovered?.id ?? assignment.modelId }
    : discovered && discovered.id !== tiers.large.model ? { ...tiers.large, model: discovered.id } : tiers.large;
  let effort = assignment && Object.hasOwn(assignment, "effort")
    ? assignment.effort ?? null : getEffortConfig("co-dm", coDm.model).effort;
  const supported = discovered?.supportedReasoningEfforts;
  if (effort && supported && !supported.includes(effort)) {
    if (assignment && Object.hasOwn(assignment, "effort")) throw new Error("Co-DM effort is not supported by its assigned model");
    const candidate = discovered?.defaultReasoningEffort ?? supported[0];
    effort = ["low", "medium", "high", "xhigh", "max"].includes(candidate ?? "") ? candidate as EffortLevel : null;
  }
  return {
    tiers,
    coDm,
    coDmEffort: discovered?.supportedReasoningEfforts?.length === 0 ? null : effort,
    ...(connStore.imageAssignment
      && connStore.imageAssignment.connectionId === connStore.tierAssignments.large?.connectionId
      ? { imageModel: connStore.imageAssignment.modelId }
      : {}),
    byConnectionId: providerCache,
  };
}
