import type { Logger } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Cross-replica shared state.
 *
 * Kravn's security-relevant ephemeral state — brute-force rate-limit counters and in-flight OIDC login
 * state — is per-process by default (fine for a single replica). To run multiple replicas correctly this
 * state must be shared, so both are funnelled through this tiny interface. With no Redis URL configured it
 * stays in-process (identical single-replica behaviour); with a URL it lives in a Redis-protocol server
 * (the Helm chart provisions Dragonfly, which speaks RESP).
 *
 * Two primitives cover both needs:
 *  - a fixed-window counter (`incr`/`peek`) for rate limiting, and
 *  - a TTL key/value (`get`/`set`/`del`) for single-use login state.
 *
 * Keys are logical; the store owns the wire prefix.
 */
export interface SharedStore {
  readonly kind: 'memory' | 'redis';
  /** Bump a fixed-window counter, opening the window (setting the TTL) on the first hit. Returns the new count and remaining ms. */
  incr(key: string, windowSeconds: number): Promise<CounterState>;
  /** Read a counter WITHOUT bumping it. Absent/expired -> { count: 0, ttlMs: 0 }. */
  peek(key: string): Promise<CounterState>;
  get(key: string): Promise<string | null>;
  /** Atomic single-use read: return the value AND delete it in one step (so two racing readers can't both win). */
  take(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
}

export interface CounterState {
  count: number;
  ttlMs: number;
}

const KEY_PREFIX = 'kravn:';

// ─── In-process implementation ─────────────────────────────────────────────────────────────────────
//
// Also the fallback path the Redis store degrades to during an outage, so its memory-safety hardening
// (bounded maps, eviction that never wipes an active block) matters even in multi-replica deployments.

const GC_INTERVAL_MS = 30_000;
const MAX_COUNTERS = 50_000;
const MAX_KV = 50_000;

interface CounterEntry {
  count: number;
  resetAt: number;
}
interface KvEntry {
  value: string;
  resetAt: number;
}

export class MemoryStore implements SharedStore {
  readonly kind = 'memory' as const;
  private counters = new Map<string, CounterEntry>();
  private kv = new Map<string, KvEntry>();
  private lastGc = 0;

  async incr(key: string, windowSeconds: number, now: number = Date.now()): Promise<CounterState> {
    this.gc(now);
    let b = this.counters.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.counters.set(key, b);
    }
    b.count++;
    return { count: b.count, ttlMs: b.resetAt - now };
  }

  async peek(key: string, now: number = Date.now()): Promise<CounterState> {
    const b = this.counters.get(key);
    if (!b || b.resetAt <= now) return { count: 0, ttlMs: 0 };
    return { count: b.count, ttlMs: b.resetAt - now };
  }

  async get(key: string, now: number = Date.now()): Promise<string | null> {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.resetAt <= now) {
      this.kv.delete(key);
      return null;
    }
    return e.value;
  }

  async take(key: string, now: number = Date.now()): Promise<string | null> {
    const e = this.kv.get(key);
    this.kv.delete(key); // single-use: always remove, even if already expired
    return e && e.resetAt > now ? e.value : null;
  }

  async set(key: string, value: string, ttlSeconds: number, now: number = Date.now()): Promise<void> {
    this.gc(now);
    this.kv.set(key, { value, resetAt: now + ttlSeconds * 1000 });
  }

  async del(key: string): Promise<void> {
    this.counters.delete(key);
    this.kv.delete(key);
  }

  async close(): Promise<void> {
    this.counters.clear();
    this.kv.clear();
  }

  private gc(now: number): void {
    if (now - this.lastGc < GC_INTERVAL_MS) return;
    this.lastGc = now;
    for (const [k, b] of this.counters) if (b.resetAt <= now) this.counters.delete(k);
    for (const [k, e] of this.kv) if (e.resetAt <= now) this.kv.delete(k);
    // Bound memory WITHOUT wiping active blocks: evict the least-threatening counters first (lowest
    // failure count, then soonest to expire). A wholesale clear would let an attacker spray junk keys to
    // reset every real block (incl. a per-email admin block) — so we never do that.
    if (this.counters.size > MAX_COUNTERS) {
      const sorted = [...this.counters.entries()].sort(
        (a, b) => a[1].count - b[1].count || a[1].resetAt - b[1].resetAt,
      );
      for (let i = 0; i < this.counters.size - MAX_COUNTERS; i++) this.counters.delete(sorted[i][0]);
    }
    // KV (in-flight logins) is capped too; evict the soonest-to-expire first (closest to being abandoned).
    if (this.kv.size > MAX_KV) {
      const sorted = [...this.kv.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (let i = 0; i < this.kv.size - MAX_KV; i++) this.kv.delete(sorted[i][0]);
    }
  }
}

// ─── Redis-protocol implementation (Dragonfly / Redis / Valkey) ─────────────────────────────────────

/** Minimal chainable pipeline shape (ioredis multi()). */
interface RedisMulti {
  get(k: string): RedisMulti;
  pttl(k: string): RedisMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/** Minimal shape we use from ioredis, so this file typechecks whether or not the types resolve. */
interface RedisLike {
  incrWindow(key: string, windowMs: string): Promise<[number, number]>;
  multi(): RedisMulti;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: string, cb: (...a: unknown[]) => void): void;
  defineCommand(name: string, def: { numberOfKeys: number; lua: string }): void;
}

const INCR_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`;

/**
 * Redis-backed store with a per-process memory fallback. A Redis/Dragonfly outage must never (a) crash the
 * gateway or (b) silently disable brute-force protection — so on any command error we degrade to the local
 * MemoryStore (protection becomes per-pod, i.e. the single-replica guarantee) and log, throttled.
 */
export class RedisStore implements SharedStore {
  readonly kind = 'redis' as const;
  private readonly fallback = new MemoryStore();
  private degradedLoggedAt = 0;
  // Circuit breaker. After a command/connection error we skip Redis for a short cooldown, then let a single
  // request probe it. This makes a sustained outage — OR a slow-but-connected server (a brownout where the
  // socket stays "ready" but commands time out) — cost at most one timed-out probe per window instead of a
  // full `commandTimeout` on EVERY auth request. `degradedUntil` = epoch ms until which the breaker is open;
  // a successful op or a fresh 'ready' closes it.
  private degradedUntil = 0;
  private static readonly BREAKER_COOLDOWN_MS = 3_000;

  private constructor(
    private readonly redis: RedisLike,
    private readonly log: Logger,
  ) {}

  static async connect(url: string, log: Logger): Promise<RedisStore> {
    // Dynamic import so a memory-only deployment never loads the driver.
    const mod = await import('ioredis');
    const Redis = (mod.default ?? mod) as unknown as new (url: string, opts: object) => RedisLike;
    const redis = new Redis(url, {
      // Queue commands issued during the INITIAL connect / a brief reconnect so they hit Redis once ready,
      // instead of spuriously failing in the first moments after boot. A hung connection is bounded by
      // commandTimeout, and a sustained outage is short-circuited by the `usable` gate (no per-call wait).
      enableOfflineQueue: true,
      maxRetriesPerRequest: 2,
      commandTimeout: 1_000,
      connectTimeout: 5_000,
      // Bounded reconnect backoff; keep trying so we recover automatically when the server returns.
      retryStrategy: (times: number) => Math.min(times * 200, 3_000),
    });
    redis.defineCommand('incrWindow', { numberOfKeys: 1, lua: INCR_WINDOW_LUA });
    const store = new RedisStore(redis, log);
    // A fresh handshake closes the breaker. Attaching an 'error' listener also opens it AND prevents an
    // unhandled ioredis 'error' from crashing the process.
    redis.on('ready', () => {
      store.degradedUntil = 0;
    });
    redis.on('error', () => {
      store.trip();
    });
    log.info('shared store: Redis-protocol backend (multi-replica)');
    return store;
  }

  /** Attempt Redis unless the breaker is open (during its cooldown we go straight to the memory fallback). */
  private get usable(): boolean {
    return Date.now() >= this.degradedUntil;
  }

  /** Open the breaker for the cooldown window. */
  private trip(): void {
    this.degradedUntil = Date.now() + RedisStore.BREAKER_COOLDOWN_MS;
  }

  private degrade(err: unknown): void {
    this.trip();
    const now = Date.now();
    if (now - this.degradedLoggedAt > 10_000) {
      this.degradedLoggedAt = now;
      this.log.warn({ err }, 'shared store degraded to per-process memory (Redis/Dragonfly unreachable)');
    }
  }

  /** Run an op against Redis when usable, else (or on error) against the in-process fallback. */
  private async run<T>(viaRedis: () => Promise<T>, viaMemory: () => Promise<T>): Promise<T> {
    if (!this.usable) return viaMemory();
    try {
      const out = await viaRedis();
      if (this.degradedUntil) this.degradedUntil = 0; // a live probe succeeded → close the breaker early
      return out;
    } catch (err) {
      this.degrade(err);
      return viaMemory();
    }
  }

  async incr(key: string, windowSeconds: number): Promise<CounterState> {
    return this.run(
      async () => {
        const [count, ttlMs] = await this.redis.incrWindow(KEY_PREFIX + key, String(windowSeconds * 1000));
        return { count, ttlMs: ttlMs > 0 ? ttlMs : windowSeconds * 1000 };
      },
      () => this.fallback.incr(key, windowSeconds),
    );
  }

  async peek(key: string): Promise<CounterState> {
    return this.run(
      async () => {
        const res = await this.redis.multi().get(KEY_PREFIX + key).pttl(KEY_PREFIX + key).exec();
        if (!res) return this.fallback.peek(key);
        // A per-command error inside the pipeline must NOT read as count 0 (that would fail open) — throw so
        // run() degrades to the bounded memory fallback instead.
        const cmdErr = res[0]?.[0] ?? res[1]?.[0];
        if (cmdErr) throw cmdErr;
        const count = Number(res[0]?.[1] ?? 0) || 0;
        const pttl = Number(res[1]?.[1] ?? 0) || 0;
        return { count, ttlMs: pttl > 0 ? pttl : 0 };
      },
      () => this.fallback.peek(key),
    );
  }

  async get(key: string): Promise<string | null> {
    return this.run(
      () => this.redis.get(KEY_PREFIX + key),
      () => this.fallback.get(key),
    );
  }

  async take(key: string): Promise<string | null> {
    return this.run(
      () => this.redis.getdel(KEY_PREFIX + key),
      () => this.fallback.take(key),
    );
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    return this.run(
      async () => {
        await this.redis.set(KEY_PREFIX + key, value, 'PX', ttlSeconds * 1000);
      },
      () => this.fallback.set(key, value, ttlSeconds),
    );
  }

  async del(key: string): Promise<void> {
    // Delete from BOTH: the key may have been written to the fallback during a blip.
    await this.fallback.del(key);
    if (!this.usable) return;
    try {
      await this.redis.del(KEY_PREFIX + key);
    } catch (err) {
      this.degrade(err);
    }
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      /* already down */
    }
  }
}

/** Build the shared store from config: Redis-protocol when a URL is set, else in-process memory. */
export async function createSharedStore(env: Env, log: Logger): Promise<SharedStore> {
  if (env.redisUrl) {
    try {
      return await RedisStore.connect(env.redisUrl, log);
    } catch (err) {
      // Never let a bad/unreachable Redis URL stop the gateway from booting — start degraded.
      log.error({ err }, 'shared store: Redis backend failed to initialize; falling back to in-process memory');
      return new MemoryStore();
    }
  }
  log.info('shared store: in-process memory (single-replica)');
  return new MemoryStore();
}
