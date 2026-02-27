import { useEffect, useRef, useCallback } from "react";
import type { SSEEvent } from "../../shared/protocol";

type SSEHandler = (event: SSEEvent) => void;

/**
 * Hook that connects to the SSE endpoint and dispatches events.
 * Auto-reconnects on disconnect (native EventSource behavior).
 */
export function useSSE(handler: SSEHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const onMessage = useCallback((type: string) => (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as SSEEvent;
      // Ensure type field matches event name
      if (data.type === type) {
        handlerRef.current(data);
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/events");

    const fileChangeHandler = onMessage("file-change");
    const campaignChangeHandler = onMessage("campaign-change");

    source.addEventListener("file-change", fileChangeHandler);
    source.addEventListener("campaign-change", campaignChangeHandler);

    return () => {
      source.removeEventListener("file-change", fileChangeHandler);
      source.removeEventListener("campaign-change", campaignChangeHandler);
      source.close();
    };
  }, [onMessage]);
}
