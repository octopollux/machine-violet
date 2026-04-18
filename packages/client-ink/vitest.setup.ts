// Ink 7's `useWindowSize` falls back to the real host terminal when the mock
// stdout doesn't expose rows (ink-testing-library only stubs `columns`). Pin
// fixed, generous dimensions so phase layout and wrapping stay deterministic
// regardless of the developer/CI host terminal size — otherwise tests drift
// between machines (e.g. a 24-row host trips the "Terminal Too Small" bailout,
// while a wider host changes wrap positions).
function pinStdoutDimension(key: "rows" | "columns", value: number) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
  if (descriptor && !descriptor.configurable) return;
  Object.defineProperty(process.stdout, key, { value, configurable: true });
}
pinStdoutDimension("rows", 40);
pinStdoutDimension("columns", 100);
