// Suppress punycode deprecation (DEP0040) from node-fetch → whatwg-url → tr46 chain.
// Must be in a separate module imported FIRST — ESM hoists static imports,
// so inline patches in index.tsx run after the SDK (and punycode) are already loaded.
const _origEmit = process.emit;
// @ts-expect-error – patching process.emit signature for warning filter
process.emit = function (ev: string | symbol, ...args: unknown[]) {
  if (ev === "warning" && args[0] instanceof Error && args[0].message.includes("punycode")) {
    return false;
  }
  // @ts-expect-error – forwarding to original emit
  return _origEmit.call(this, ev, ...args);
};
