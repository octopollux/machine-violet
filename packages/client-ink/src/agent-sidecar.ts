/**
 * Agent sidecar — dev-only HTTP server for AI agent integration testing.
 *
 * Embeds in the TUI client process to let agents observe the rendered
 * terminal screen (via @xterm/headless virtual terminal) and inject
 * keystrokes. When a real TTY is present, input goes via
 * process.stdin.unshift(); in headless mode (no TTY), start-client
 * creates a mock TTY stream and passes it here for direct push().
 *
 * Activated by `--agent-port <port>` or `MV_AGENT_PORT` env var.
 * Excluded from release builds: this module is only reached via a
 * guarded dynamic import() in start-client.ts.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ClientState } from "./event-handler.js";

// ---------------------------------------------------------------------------
// Key map: friendly name → terminal escape sequence
// ---------------------------------------------------------------------------

export const KEY_MAP: Record<string, string> = {
  return: "\r",
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  backspace: "\x7f",
  delete: "\x1b[3~",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  "ctrl+a": "\x01",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+l": "\x0c",
  "ctrl+u": "\x15",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the full body of an incoming HTTP request as a Buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Sidecar entry point
// ---------------------------------------------------------------------------

export interface SidecarHandle {
  close(): Promise<void>;
}

export async function startAgentSidecar(
  port: number,
  getClientState: () => ClientState,
  inputStream?: NodeJS.ReadStream,
): Promise<SidecarHandle> {
  // Dynamic imports — keeps @xterm/headless out of the static import graph.
  const { Terminal } = await import("@xterm/headless");
  const { SerializeAddon } = await import("@xterm/addon-serialize");

  // Keystroke injection: use the mock stream if provided, else process.stdin.
  const pushInput = (data: Buffer) => {
    if (inputStream) {
      inputStream.push(data);
    } else {
      process.stdin.unshift(data);
    }
  };

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);

  // Track terminal resize.
  const onResize = () => term.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  process.stdout.on("resize", onResize);

  // --- Stdout tee ---
  // Installed AFTER syncWriteCombiner so we see atomic frames.
  const originalWrite: NodeJS.WriteStream["write"] = process.stdout.write;
  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    term.write(str);
    return originalWrite.call(process.stdout, chunk, encodingOrCb as BufferEncoding, cb) as boolean;
  } as NodeJS.WriteStream["write"];

  // --- Screen reading ---
  function readScreen(): string {
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < term.rows; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines.join("\n");
  }

  function readScreenAnsi(): string {
    return serializeAddon.serialize();
  }

  // --- HTTP server ---
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/screen") {
        const ansi = url.searchParams.get("ansi") === "true";
        const body = ansi ? readScreenAnsi() : readScreen();
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(body);
        return;
      }

      if (req.method === "GET" && path === "/state") {
        const body = JSON.stringify(getClientState());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return;
      }

      if (req.method === "POST" && path === "/input") {
        const body = await readBody(req);
        pushInput(body);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "POST" && path === "/input/key") {
        const body = await readBody(req);
        let parsed: { key?: string };
        try {
          parsed = JSON.parse(body.toString("utf-8"));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const key = parsed.key?.toLowerCase();
        const seq = key ? KEY_MAP[key] : undefined;
        if (!seq) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Unknown key: ${parsed.key}`, known: Object.keys(KEY_MAP) }));
          return;
        }
        pushInput(Buffer.from(seq));
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  process.stderr.write(`Agent sidecar listening on http://127.0.0.1:${boundPort}\n`);

  return {
    async close() {
      process.stdout.write = originalWrite;
      process.stdout.removeListener("resize", onResize);
      term.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
