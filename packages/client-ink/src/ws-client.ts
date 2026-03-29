/**
 * WebSocket client with typed event parsing and auto-reconnect.
 *
 * Connects to the engine server's /session/ws endpoint.
 * Parses incoming messages as ServerEvent discriminated union.
 * Fires typed callbacks for each event kind.
 */
import type { ServerEvent } from "@machine-violet/shared";

export type EventHandler = (event: ServerEvent) => void;
export type ConnectionHandler = () => void;

export interface WsClientConfig {
  /** Full WebSocket URL (e.g. ws://127.0.0.1:7200/session/ws?role=player&player=aldric) */
  url: string;
  /** Called for every server event. */
  onEvent: EventHandler;
  /** Called when the connection opens. */
  onConnect?: ConnectionHandler;
  /** Called when the connection closes (before reconnect attempt). */
  onDisconnect?: ConnectionHandler;
  /** Called on parse errors or unexpected messages. */
  onError?: (error: Error) => void;
  /** Max reconnect attempts before giving up. Default 10. */
  maxReconnectAttempts?: number;
  /** Base delay between reconnect attempts in ms. Default 1000. Exponential backoff. */
  reconnectBaseDelay?: number;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private config: Required<WsClientConfig>;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(config: WsClientConfig) {
    this.config = {
      maxReconnectAttempts: 10,
      reconnectBaseDelay: 1000,
      onConnect: () => { /* default no-op */ },
      onDisconnect: () => { /* default no-op */ },
      onError: () => { /* default no-op */ },
      ...config,
    };
  }

  /** Open the WebSocket connection. */
  connect(): void {
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  /** Close the connection without reconnecting. */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
  }

  /** True if the WebSocket is currently open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // --- Private ---

  private doConnect(): void {
    try {
      this.ws = new WebSocket(this.config.url);
    } catch (err) {
      this.config.onError(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.config.onConnect();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        const parsed = JSON.parse(data) as ServerEvent;
        this.config.onEvent(parsed);
      } catch (err) {
        this.config.onError(
          err instanceof Error ? err : new Error(`Failed to parse WS message: ${err}`),
        );
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.config.onDisconnect();
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // The close event will fire after this — reconnect is handled there.
      // Don't call onError here; WebSocket error events have no useful info.
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.config.onError(
        new Error(`Failed to reconnect after ${this.config.maxReconnectAttempts} attempts`),
      );
      return;
    }

    const delay = this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }
}
