import type { SharedStore } from '../cluster/shared-store.js';

/**
 * Brute-force limiter for local login and the public OAuth endpoints.
 *
 * Counts attempts per key (we key by client IP and by email) in a fixed window; once `max` hits accumulate
 * within the window the key is blocked until the window resets. Successful logins clear the key so a
 * legitimate user is never penalised. Counting only failures (not every request) means a normal user typing
 * one wrong password isn't locked, while a spray gets stopped fast.
 *
 * State lives in the injected SharedStore: a single replica keeps it in-process (as before); behind multiple
 * replicas a Redis-protocol store (Dragonfly) makes the limit shared and correct across pods. Each limiter
 * gets its own namespace so independent buckets (login vs OAuth) never collide in a shared keyspace.
 */
export class LoginRateLimiter {
  constructor(
    private readonly store: SharedStore,
    private readonly namespace: string,
  ) {}

  /** Seconds the key must wait before another attempt, or 0 if not currently blocked. */
  async blockedFor(key: string, max: number): Promise<number> {
    const { count, ttlMs } = await this.store.peek(this.k(key));
    return count >= max && ttlMs > 0 ? Math.max(1, Math.ceil(ttlMs / 1000)) : 0;
  }

  /** Record an attempt, opening a fresh window if needed. */
  async recordFailure(key: string, windowSeconds: number): Promise<void> {
    await this.store.incr(this.k(key), windowSeconds);
  }

  /** Clear a key after a successful login. */
  async clear(key: string): Promise<void> {
    await this.store.del(this.k(key));
  }

  private k(key: string): string {
    return `rl:${this.namespace}:${key}`;
  }
}
