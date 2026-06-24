/**
 * E2E harness affordances — the umbrella `MV_E2E=1` flag.
 *
 * Set only by the test harness (never in production), `MV_E2E=1` unlocks the
 * boot path so the app can be driven end-to-end against a tape with no real
 * credentials. Today it does one thing: surface a single synthetic, always-
 * "valid" connection so the client menu unlocks (it gates "New Campaign" on
 * `connections.length > 0` + a passing health check) and the setup agent can
 * run. The synthetic connection is cosmetic — actual LLM calls route through
 * the replay tier seam (`MV_TAPE_MODE=replay`, see {@link buildReplayTierProviders}),
 * which ignores connections entirely.
 *
 * `MV_E2E` is deliberately separate from `MV_TAPE_MODE=replay`: the former is
 * the harness boot affordance, the latter the provider behavior. The harness
 * sets both; keeping them distinct keeps each seam single-purpose.
 *
 * See docs/e2e-harness.md.
 */
import type { AIConnection, ConnectionStore } from "./connections.js";

export function e2eActive(): boolean {
  return process.env.MV_E2E === "1";
}

const E2E_CONN_ID = "e2e-replay";
const E2E_MODEL = "replay-tape";

/** Health-check verdict the management route returns for the synthetic connection. */
export const E2E_HEALTH = { status: "valid" as const, message: "replay provider (no network)" };

/**
 * A synthetic connection store for E2E runs: one always-valid connection with
 * all three tiers assigned to it. Lets the client render a configured state
 * without any real key. Source `"env"` so it's never persisted by
 * `saveConnectionStore` (which strips env connections).
 */
export function e2eConnectionStore(): ConnectionStore {
  const conn: AIConnection = {
    id: E2E_CONN_ID,
    provider: "anthropic",
    label: "Replay (E2E)",
    apiKey: "e2e",
    models: [{ id: E2E_MODEL, displayName: "Replay", available: true }],
    source: "env",
    addedAt: "1970-01-01T00:00:00.000Z",
  };
  const assignment = { connectionId: E2E_CONN_ID, modelId: E2E_MODEL };
  return {
    connections: [conn],
    tierAssignments: { large: assignment, medium: assignment, small: assignment },
  };
}
