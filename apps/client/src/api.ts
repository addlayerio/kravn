const TOKEN_KEY = 'kravn_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const err = payload?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`);
  }
  return payload as T;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers = { ...extra };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {});
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return handle<T>(res);
}

/**
 * POST an endpoint that answers with Server-Sent Events instead of one JSON body — for work that takes
 * minutes (a chat turn) and would otherwise be cut off by a proxy while the socket sits silent.
 *
 * Uses fetch + a reader rather than the native EventSource, which is GET-only and cannot carry the
 * Authorization header. Resolves when the server closes the stream — which is NOT by itself a verdict: a
 * dropped connection also ends the loop, so the caller must decide based on the events it actually saw.
 * Heartbeat comments are skipped; their only job is keeping the connection alive on the way here.
 */
export async function postSse(
  path: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) await handle<void>(res); // stream never started — always throws the server's error envelope
  if (!res.body) throw new ApiError(res.status, 'stream', 'The server did not return a stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue; // comment — the heartbeat lands here
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data.join('\n'));
      } catch {
        continue; // malformed frame — skip it rather than kill the stream
      }
      onEvent(event, payload); // outside the try: a bug in the consumer must surface, not look like bad JSON
    }
  }
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
  /** Multipart upload of a single file (do not set Content-Type — the browser sets the boundary). */
  upload: async <T>(p: string, file: File): Promise<T> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(p, { method: 'POST', headers: authHeaders(), body: fd });
    return handle<T>(res);
  },
  /** Fetch a binary endpoint (with auth) as a Blob — for downloads. */
  blob: async (p: string): Promise<Blob> => {
    const res = await fetch(p, { headers: authHeaders() });
    if (!res.ok) throw new ApiError(res.status, 'error', `Download failed (${res.status})`);
    return res.blob();
  },
};
