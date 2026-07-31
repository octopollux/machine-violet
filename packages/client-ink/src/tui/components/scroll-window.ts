export interface ScrollWindow {
  start: number;
  end: number;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

/**
 * Keep a selected one-row item inside a stable viewport. The window only
 * moves when the selection crosses an edge, matching the choice list in the
 * PlayingPhase player pane. Shared by every scrollable full-screen menu.
 */
export function getScrollWindow(
  selectedIndex: number,
  itemCount: number,
  visibleRows: number,
  previousStart: number,
): ScrollWindow {
  const rowCount = Math.max(2, visibleRows);
  const maxStart = Math.max(0, itemCount - rowCount);
  let start = Math.min(Math.max(0, previousStart), maxStart);

  if (selectedIndex < start) {
    start = selectedIndex;
  } else if (selectedIndex >= start + rowCount) {
    start = selectedIndex - rowCount + 1;
  }
  start = Math.min(Math.max(0, start), maxStart);

  const end = Math.min(itemCount, start + rowCount);
  return {
    start,
    end,
    canScrollUp: start > 0,
    canScrollDown: end < itemCount,
  };
}
