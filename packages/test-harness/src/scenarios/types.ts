/**
 * Scenario contract.
 *
 * A scenario is an async function that receives a started Harness and runs
 * to completion (success) or throws (failure). The runner takes care of
 * launching/shutting down the harness; the scenario only describes what to
 * do once it's up.
 *
 * Every scenario MUST be able to run idempotently — fresh launcher, fresh
 * tmp campaigns dir. Don't depend on prior runs.
 */
import type { Harness } from "../harness.js";

export interface ScenarioContext {
  harness: Harness;
  /** Write a progress line. Goes to stderr so it doesn't pollute stdout pipes. */
  log: (msg: string) => void;
}

export interface Scenario {
  /** Stable id; used on the CLI and in CI. */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** One-line description of what the scenario proves. */
  description: string;
  /**
   * Whether the scenario makes real LLM API calls. CI / hooks that run
   * scenarios in bulk should default to live=false for filtering.
   */
  live: boolean;
  /** Approximate wall-clock budget. Informational; not enforced. */
  approxMinutes: number;
  /** The actual scenario body. */
  run: (ctx: ScenarioContext) => Promise<void>;
}
