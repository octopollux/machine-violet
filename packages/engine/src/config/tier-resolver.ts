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
import { getModel } from "./models.js";

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
export function buildTierProviders(
  connStore: ConnectionStore,
  fallbackProvider: () => LLMProvider,
): Record<ModelTier, TierProvider> {
  const providerCache = new Map<string, LLMProvider>();
  const getProviderForConnId = (connId: string): LLMProvider => {
    let p = providerCache.get(connId);
    if (!p) {
      const conn = connStore.connections.find((c) => c.id === connId);
      if (!conn) throw new Error(`Connection not found: ${connId}`);
      p = createProviderFromConnection(conn);
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

  return {
    large: resolveTier("large"),
    medium: resolveTier("medium"),
    small: resolveTier("small"),
  };
}
