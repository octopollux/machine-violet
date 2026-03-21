import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { Opcode, type RPCFrame } from "./types.js";

const HEADER_SIZE = 8;
const CONNECT_TIMEOUT_MS = 500;
const MAX_PIPE_INDEX = 9;

/** Resolve the platform-specific IPC pipe path for a given index. */
export function getPipePath(index: number): string {
  if (process.platform === "win32") {
    return `\\\\?\\pipe\\discord-ipc-${index}`;
  }
  const base =
    process.env.XDG_RUNTIME_DIR ??
    process.env.TMPDIR ??
    process.env.TMP ??
    process.env.TEMP ??
    "/tmp";
  return join(base, `discord-ipc-${index}`);
}

/** Encode a Discord IPC frame: [opcode u32 LE][length u32 LE][JSON]. */
export function encodeFrame(opcode: Opcode, payload: object): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

/** Decoded frame from the IPC stream. */
export interface DecodedFrame {
  opcode: Opcode;
  data: RPCFrame;
}

/**
 * Low-level Discord IPC client over named pipes.
 *
 * Handles connection, binary framing, and handshake.
 * All public methods fail silently — this is a cosmetic feature.
 */
export class DiscordIPCClient {
  private socket: Socket | null = null;
  private _connected = false;
  private buffer = Buffer.alloc(0);
  private pendingResolve: ((frame: DecodedFrame) => void) | null = null;

  get connected(): boolean {
    return this._connected;
  }

  /** Try pipes 0–9. Returns true if a connection was established. */
  async connect(): Promise<boolean> {
    for (let i = 0; i <= MAX_PIPE_INDEX; i++) {
      const path = getPipePath(i);
      try {
        const socket = await this.tryConnect(path);
        this.socket = socket;
        this._connected = true;

        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("close", () => {
          this._connected = false;
          this.socket = null;
        });
        socket.on("error", () => {
          this._connected = false;
          this.socket = null;
        });

        return true;
      } catch {
        // This pipe index isn't available — try next
      }
    }
    return false;
  }

  /** Send the handshake and wait for the READY dispatch. */
  async handshake(clientId: string): Promise<boolean> {
    if (!this.socket) return false;
    try {
      this.socket.write(encodeFrame(Opcode.HANDSHAKE, { v: 1, client_id: clientId }));
      const response = await this.waitForFrame(5000);
      return response.opcode === Opcode.FRAME && response.data.evt === "READY";
    } catch {
      return false;
    }
  }

  /** Send a framed RPC message. */
  async send(opcode: Opcode, payload: object): Promise<void> {
    if (!this.socket || !this._connected) return;
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch {
      // Silent failure
    }
  }

  /** Close the connection. */
  async close(): Promise<void> {
    this._connected = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      return new Promise((resolve) => {
        socket.once("close", resolve);
        socket.destroy();
      });
    }
  }

  private tryConnect(path: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path }, () => resolve(socket));
      socket.once("error", reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error("timeout"));
      }, CONNECT_TIMEOUT_MS);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.tryParseFrames();
  }

  private tryParseFrames(): void {
    while (this.buffer.length >= HEADER_SIZE) {
      const opcode = this.buffer.readUInt32LE(0) as Opcode;
      const length = this.buffer.readUInt32LE(4);

      if (this.buffer.length < HEADER_SIZE + length) break;

      const json = this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length).toString("utf-8");
      this.buffer = this.buffer.subarray(HEADER_SIZE + length);

      // Handle PING with automatic PONG
      if (opcode === Opcode.PING) {
        void this.send(Opcode.PONG, JSON.parse(json) as object);
        continue;
      }

      try {
        const data = JSON.parse(json) as RPCFrame;
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.pendingResolve = null;
          resolve({ opcode, data });
        }
      } catch {
        // Malformed JSON — skip frame
      }
    }
  }

  private waitForFrame(timeoutMs: number): Promise<DecodedFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolve = null;
        reject(new Error("timeout waiting for frame"));
      }, timeoutMs);

      this.pendingResolve = (frame: DecodedFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }
}
