import type { FastifyReply } from 'fastify';

/** A hijacked Server-Sent Events response. `send` is best-effort — writing to a socket the client already
 *  dropped is a no-op, never a throw, so a disconnected browser can't fail the work producing the events. */
export interface SseStream {
  send(event: string, data?: unknown): void;
  close(): void;
}

/**
 * Open an SSE stream on a hijacked reply — the house pattern, extracted here at the third use.
 *
 * The headers and the heartbeat are the whole point of this helper. A proxy between the browser and Kravn
 * decides a request is dead by how long the ORIGIN stays silent — Cloudflare returns 524 after ~100s of it,
 * and nginx's proxy_read_timeout is likewise an inter-read gap, not a total. So a long turn is safe only if
 * bytes keep flowing: `writeHead` answers immediately (the response has begun before any work starts) and the
 * heartbeat comment refreshes the clock every 25s for as long as the work takes. `X-Accel-Buffering` stops
 * nginx from holding those bytes back and defeating the whole arrangement.
 *
 * (apps/gateway/src/routes/events.routes.ts and logs.routes.ts predate this helper and still hand-roll the
 * same block; they work, so they're left alone rather than churned by an unrelated fix.)
 */
export function openSse(reply: FastifyReply, heartbeatMs = 25_000): SseStream {
  reply.hijack(); // we own the socket; Fastify won't send a response
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let nginx buffer the stream
  });

  const write = (frame: string) => {
    try {
      raw.write(frame);
    } catch {
      /* socket closed */
    }
  };
  write(': connected\n\n'); // first byte now, not when the work finishes — this is what the proxy waits for

  let closed = false;
  const heartbeat = setInterval(() => write(': hb\n\n'), heartbeatMs);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };
  // Watch the RESPONSE, not the request. Node fires 'close' on the request as soon as its body has been fully
  // READ — which, on a POST, Fastify has already done before the handler runs. Binding cleanup there kills the
  // heartbeat within milliseconds while the client is still happily connected, and the stream silently loses
  // the very thing it exists for. (The GET precedents get away with it: no body, so the request only closes
  // when the socket does.)
  reply.raw.on('close', cleanup);
  reply.raw.on('error', cleanup);

  return {
    // JSON.stringify escapes newlines, so a payload can never break out of its `data:` line.
    send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`),
    close: () => {
      cleanup();
      try {
        raw.end();
      } catch {
        /* ignore */
      }
    },
  };
}
