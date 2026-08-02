/**
 * Browser rig for the inline-image visual testbed (issue #782).
 *
 * Serves an xterm.js page with the image addon (decodes BOTH sixel and iTerm2
 * IIP — kitty is not supported by xterm.js) and bridges it over a websocket to
 * the Ink testbed app (image-testbed-app.tsx) spawned as a child process with
 * a faked TTY. The page measures its real cell pixel size and passes it to the
 * app so bands land exactly on cell rows.
 *
 *   npm run image-testbed          # then open http://127.0.0.1:7391/
 *   http://127.0.0.1:7391/?protocol=iterm2   # exercise the iTerm2 driver
 *
 * Verification is programmatic, not eyeball-only: in the page's devtools,
 * `imageAddon.getImageAtBufferCell(x, y)` reports which cells hold image
 * pixels, and the returned bitmap's dimensions verify band cropping.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
const PORT = Number(process.env.PORT ?? 7391);
const require = createRequire(import.meta.url);

const files: Record<string, { path: string; type: string }> = {
  "/": { path: join(__dirname, "image-testbed.html"), type: "text/html" },
  "/xterm.js": { path: require.resolve("@xterm/xterm/lib/xterm.js"), type: "text/javascript" },
  "/xterm.css": { path: require.resolve("@xterm/xterm/css/xterm.css"), type: "text/css" },
  "/addon-image.js": { path: require.resolve("@xterm/addon-image/lib/addon-image.js"), type: "text/javascript" },
};

const server = createServer((req, res) => {
  const f = files[(req.url ?? "/").split("?")[0]];
  if (!f) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": f.type });
  res.end(readFileSync(f.path));
});

interface HelloMsg { type: "hello"; cols: number; rows: number; cellW: number; cellH: number; protocol?: string }
interface InputMsg { type: "input"; data: string }

const wss = new WebSocketServer({ server, path: "/term" });
wss.on("connection", (ws) => {
  let child: ChildProcess | null = null;
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(String(data)) as HelloMsg | InputMsg;
    if (msg.type === "hello" && !child) {
      child = spawn(
        process.execPath,
        ["--import", "tsx/esm", join(REPO, "packages/test-harness/bin/image-testbed-app.tsx")],
        {
          cwd: REPO,
          env: {
            ...process.env,
            COLS: String(msg.cols),
            ROWS: String(msg.rows),
            CELL_W: String(Math.round(msg.cellW)),
            CELL_H: String(Math.round(msg.cellH)),
            PROTOCOL: msg.protocol ?? "sixel",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdout?.on("data", (buf: Buffer) => { if (ws.readyState === 1) ws.send(buf); });
      child.stderr?.on("data", (buf: Buffer) => console.error("[app]", buf.toString()));
      child.on("exit", (code) => {
        console.log("[app] exited", code);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "exit", code }));
      });
    } else if (msg.type === "input" && child) {
      child.stdin?.write(msg.data);
    }
  });
  ws.on("close", () => {
    child?.kill();
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`image testbed at http://127.0.0.1:${PORT}/  (append ?protocol=iterm2 for IIP)`));
