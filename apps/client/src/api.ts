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
