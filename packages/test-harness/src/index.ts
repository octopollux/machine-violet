/**
 * Machine Violet end-to-end test harness.
 *
 * See `docs/e2e-harness.md` for the full reference and the probe catalogue.
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
export {
  engineLogPath,
  readEngineLog,
  findEngineEvents,
  waitForEngineEvent,
  formatEngineEvent,
  type EngineLogEvent,
} from "./engine-log.js";
export { runProbe, type ProbeContext, type RunProbeOptions } from "./run-probe.js";
export {
  buildLaunchEnv,
  findConfigDir,
  injectApiKeysFromEnvFile,
  pickEphemeralPort,
  REPO_ROOT,
  LAUNCHER_PATH,
  LAUNCHER_NODE_ARGS,
  type LaunchEnvOptions,
} from "./launch-env.js";
export {
  start as playStart,
  stop as playStop,
  status as playStatus,
  screen as playScreen,
  state as playState,
  narrative as playNarrative,
  say as playSay,
  key as playKey,
  pick as playPick,
  wait as playWait,
  log as playLog,
  list as playList,
  resolveSessionId,
  sessionPaths,
  DEFAULT_SESSION_ID,
  type StartOptions,
  type SessionPaths,
  type WaitOptions as PlayWaitOptions,
  type WaitFor,
} from "./session-driver.js";
