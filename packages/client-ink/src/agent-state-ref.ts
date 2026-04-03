/**
 * Module-level state ref for the agent sidecar.
 *
 * Separated from start-client.ts and app.tsx to avoid a circular
 * import: start-client imports App, and App needs to write state here.
 */
import { initialClientState, type ClientState } from "./event-handler.js";

let _clientState: ClientState = initialClientState();

export function setAgentClientState(s: ClientState): void { _clientState = s; }
export function getAgentClientState(): ClientState { return _clientState; }
