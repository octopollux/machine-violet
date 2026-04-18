// Ink 7's `useWindowSize` falls back to the real host terminal when the mock
// stdout doesn't expose rows (ink-testing-library only stubs `columns`). On a
// dev machine with < MIN_ROWS rows, phase components render "Terminal Too
// Small" and every content assertion fails. Force a generous default so tests
// stay terminal-size-agnostic.
if (!process.stdout.rows || process.stdout.rows < 40) {
  Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
}
if (!process.stdout.columns || process.stdout.columns < 100) {
  Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
}
