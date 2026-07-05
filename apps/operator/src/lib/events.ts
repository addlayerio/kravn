import { onUnmounted } from 'vue';
import { getToken } from '../api/client';

/**
 * Subscribe to the gateway's Server-Sent Events stream (/api/events) for live updates — the standard way the
 * operator learns of changes, instead of polling an API on a timer. Uses a fetch-based reader (not the native
 * EventSource) so the Bearer token rides the Authorization header. Auto-reconnects on drop, and unsubscribes
 * automatically when the calling component unmounts.
 *
 *   useEventStream((type) => { if (type === 'registry') load(); });
 */
export function useEventStream(onEvent: (type: string) => void): void {
  let closed = false;
  let controller: AbortController | null = null;

  async function run() {
    while (!closed) {
      controller = new AbortController();
      try {
        const res = await fetch('/api/events', {
          headers: { Authorization: `Bearer ${getToken() ?? ''}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const m = /(^|\n)event:\s*(.+)/.exec(frame);
            if (m) onEvent(m[2].trim());
          }
        }
      } catch {
        /* connection dropped — fall through to reconnect */
      }
      if (!closed) await new Promise((r) => window.setTimeout(r, 3000)); // backoff before reconnecting
    }
  }

  run();
  onUnmounted(() => {
    closed = true;
    controller?.abort();
  });
}
