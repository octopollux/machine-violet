// @machine-violet/client-ink
// Ink TUI client connecting to the engine server over REST + WebSocket.

export { ApiClient, ApiError } from "./api-client.js";
export { WsClient } from "./ws-client.js";
export type { WsClientConfig, EventHandler, ConnectionHandler } from "./ws-client.js";
export { createEventHandler, initialClientState } from "./event-handler.js";
export type { ClientState, StateUpdater } from "./event-handler.js";
