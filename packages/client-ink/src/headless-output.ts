/** Tell Ink that the sidecar's fixed-size virtual terminal is a terminal.
 * A piped stdout otherwise disables fullscreen rendering and adds a trailing
 * newline, scrolling a viewport-height frame before incremental updates.
 * Bind I/O to the original stream so existing tees/atomic frame wrappers remain
 * authoritative; this changes Ink's view only, never process.stdout itself.
 */
export function headlessTerminalOutput(stream: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(stream, {
    get(target, key) {
      if (key === "isTTY") return true;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
