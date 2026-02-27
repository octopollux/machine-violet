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
    console.log(`[SSE] raw ${type} event:`, e.data);
    try {
      const data = JSON.parse(e.data) as SSEEvent;
      if (data.type === type) {
        handlerRef.current(data);
      }
    } catch (err) {
      console.warn("[SSE] parse error:", err);
    }
  }, []);

  useEffect(() => {
    // In dev, connect directly to Express to bypass Vite's buffering proxy
    const base = window.location.port === "5199" ? "http://localhost:3999" : "";
    const url = `${base}/api/events`;
    console.log(`[SSE] connecting to ${url}...`);
    const source = new EventSource(url);

    source.onopen = () => console.log("[SSE] connection opened");
    source.onerror = (e) => console.warn("[SSE] error/reconnect:", e);

    const fileChangeHandler = onMessage("file-change");
    const campaignChangeHandler = onMessage("campaign-change");

    source.addEventListener("connected", (e) => {
      console.log("[SSE] server welcome:", (e as MessageEvent).data);
    });
    source.addEventListener("file-change", fileChangeHandler);
    source.addEventListener("campaign-change", campaignChangeHandler);

    return () => {
      console.log("[SSE] closing");
      source.removeEventListener("file-change", fileChangeHandler);
      source.removeEventListener("campaign-change", campaignChangeHandler);
      source.close();
    };
  }, [onMessage]);
}
