import React from "react";
import { Box, Text, render } from "ink";
import { Readable, Writable } from "node:stream";
import { Terminal } from "@xterm/headless";
import { describe, it, expect, vi } from "vitest";
import { headlessTerminalOutput } from "./headless-output.js";

describe("headless fullscreen incremental rendering", () => {
  it.each([false, true])("actual xterm fullscreen rendering with virtual TTY=%s", async (virtualTty) => {
    const term = new Terminal({ cols: 30, rows: 6, allowProposedApi: true, convertEol: true });
    let pending = Promise.resolve();
    const output = new Writable({ write(chunk, _encoding, callback) {
      pending = pending.then(() => new Promise<void>((resolve) => term.write(String(chunk), resolve)));
      callback();
    } }) as NodeJS.WriteStream;
    output.columns = 30; output.rows = 6; output.isTTY = false;
    const input = new Readable({ read() {} }) as NodeJS.ReadStream;
    input.isTTY = true; input.setRawMode = () => input; input.ref = () => input; input.unref = () => input;
    const frame = (tick: number) => <Box flexDirection="column" width={30} height={6}>
      <Text>Machine Violet</Text><Text>New Campaign</Text><Text>{`animation ${tick}`}</Text>
      <Text>static middle</Text><Text>Settings</Text><Text>Quit</Text>
    </Box>;
    const app = render(frame(0), { stdin: input, stdout: virtualTty ? headlessTerminalOutput(output) : output, stderr: output, interactive: true, incrementalRendering: true, alternateScreen: false, patchConsole: false });
    const screen = () => Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(term.buffer.active.baseY + i)?.translateToString(true) ?? "").join("\n");
    try {
      await pending;
      // Reproduce the old piped-stream bug: a newline after six visible rows
      // scrolls the first row away, even though Ink is explicitly interactive.
      if (!virtualTty) {
        expect(screen()).not.toContain("Machine Violet");
        expect(term.buffer.active.baseY).toBeGreaterThan(0);
        return;
      }
      expect(screen()).toContain("Machine Violet");
      for (let tick = 1; tick <= 3; tick++) {
        app.rerender(frame(tick));
        await vi.waitFor(async () => { await pending; expect(screen()).toContain(`animation ${tick}`); });
        expect(screen()).toContain("Machine Violet"); expect(screen()).toContain("New Campaign"); expect(screen()).toContain("Quit");
        expect(term.buffer.active.baseY).toBe(0);
      }
      expect(output.isTTY).toBe(false);
    } finally { app.unmount(); await pending; term.dispose(); }
  });
});
