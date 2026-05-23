/**
 * Machine Violet end-to-end test harness.
 *
 * See `docs/e2e-harness.md` for the full reference and the scenario catalogue.
 */
export { Harness } from "./harness.js";
export type { HarnessOptions, ShutdownOptions } from "./harness.js";
export type {
  ClientStateSnapshot,
  ActiveChoices,
  Choice,
  Turn,
  NarrativeLine,
} from "./client-state.js";
export { choiceLabel } from "./client-state.js";
export {
  pollUntil,
  TimeoutError,
  DEFAULT_POLL_MS,
  DEFAULT_SHORT_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_LONG_TIMEOUT_MS,
  type WaitOptions,
} from "./wait.js";
