import { setGlobalDispatcher } from 'undici';
import type { SsrfGuard } from './ssrf.js';

/**
 * Install the SSRF-pinning dispatcher as the GLOBAL dispatcher so that ALL outbound `fetch`
 * — including the ones the MCP SDK transports make internally — go through connect-time IP
 * validation and pinning. Redirects are re-validated because every new connection re-runs lookup.
 */
export function installGlobalSsrfDispatcher(guard: SsrfGuard): void {
  setGlobalDispatcher(guard.agent);
}

/** Convenience wrapper for our own outbound calls (health checks, etc.). */
export async function safeFetch(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'manual', ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
