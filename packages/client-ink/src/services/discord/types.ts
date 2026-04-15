/** Discord IPC opcodes for the Rich Presence protocol. */
export enum Opcode {
  HANDSHAKE = 0,
  FRAME = 1,
  CLOSE = 2,
  PING = 3,
  PONG = 4,
}

/** Activity timestamps shown in the Rich Presence display. */
export interface ActivityTimestamps {
  start?: number;
  end?: number;
}

/** Asset keys registered in the Discord Developer Portal. */
export interface ActivityAssets {
  large_image?: string;
  large_text?: string;
  small_image?: string;
  small_text?: string;
}

/** Discord Rich Presence activity payload. */
export interface DiscordActivity {
  details?: string;
  state?: string;
  timestamps?: ActivityTimestamps;
  assets?: ActivityAssets;
}

/** A framed RPC message sent to/from Discord. */
export interface RPCFrame {
  cmd: string;
  args?: Record<string, unknown>;
  evt?: string | null;
  nonce?: string | null;
  data?: Record<string, unknown>;
}

/** Configuration for initializing a Rich Presence session. */
export interface PresenceConfig {
  clientId: string;
  campaignName: string;
  dmPersona: string;
}
