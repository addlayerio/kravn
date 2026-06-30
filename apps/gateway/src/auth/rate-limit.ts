/**
 * In-memory brute-force limiter for local login.
 *
 * Counts FAILED attempts per key (we key by client IP and by email) in a fixed window; once `max`
 * failures accumulate within the window the key is blocked until the window resets. Successful logins
 * clear the key so a legitimate user is never penalised. Counting only failures (not every request)
 * means a normal user typing one wrong password isn't locked, while a spray gets stopped fast.
 *
 * Note: state is per-process. Behind multiple replicas the effective limit is per-pod (no shared store
 * like Redis), which still drastically raises the cost of an internet-facing brute force. The map is
 * GC'd and hard-capped so a high-cardinality spray can't exhaust memory.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const GC_INTERVAL_MS = 30_000;
const MAX_BUCKETS = 50_000;

export class LoginRateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastGc = 0;

  /** Seconds the key must wait before another attempt, or 0 if not currently blocked. */
  blockedFor(key: string, max: number, now: number = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) return 0;
    return b.count >= max ? Math.max(1, Math.ceil((b.resetAt - now) / 1000)) : 0;
  }

  /** Record a failed attempt, opening a fresh window if needed. */
  recordFailure(key: string, windowSeconds: number, now: number = Date.now()): void {
    this.gc(now);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.buckets.set(key, b);
    }
    b.count++;
  }

  /** Clear a key after a successful login. */
  clear(key: string): void {
    this.buckets.delete(key);
  }

  private gc(now: number): void {
    if (now - this.lastGc < GC_INTERVAL_MS) return;
    this.lastGc = now;
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    // Bound memory WITHOUT wiping active blocks: evict the least-threatening buckets first (lowest
    // failure count, then soonest to expire). A wholesale clear() would let an attacker spray junk keys
    // to reset every real block (incl. the per-email admin block) — so we never do that.
    if (this.buckets.size > MAX_BUCKETS) {
      const sorted = [...this.buckets.entries()].sort(
        (a, b) => a[1].count - b[1].count || a[1].resetAt - b[1].resetAt,
      );
      const toDrop = this.buckets.size - MAX_BUCKETS;
      for (let i = 0; i < toDrop; i++) this.buckets.delete(sorted[i][0]);
    }
  }
}
