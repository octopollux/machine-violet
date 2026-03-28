import type React from "react";
import { useImperativeHandle } from "react";
import type { ScrollViewRef } from "ink-scroll-view";

export interface ScrollHandle {
  scrollBy(delta: number): void;
}

/**
 * Expose a scrollBy handle via useImperativeHandle.
 * Forward scroll is clamped to available room; backward is unclamped.
 */
export function useScrollHandle(
  ref: React.ForwardedRef<ScrollHandle>,
  scrollRef: React.RefObject<ScrollViewRef | null>,
): void {
  useImperativeHandle(ref, () => ({
    scrollBy(delta: number) {
      const sv = scrollRef.current;
      if (!sv) return;
      if (delta > 0) {
        const room = sv.getBottomOffset() - sv.getScrollOffset();
        if (room <= 0) return;
        sv.scrollBy(Math.min(delta, room));
      } else {
        sv.scrollBy(delta);
      }
    },
  }), []);
}
