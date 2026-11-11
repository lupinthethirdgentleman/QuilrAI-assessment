/**
 * Token-aware sliding-window rate limiter, persisted to on-disk SQLite (node:sqlite).
 *
 * Model: a sliding *log*. Every admitted request writes a row (tenant, ts, tokens).
 * A tenant's usage is SUM(tokens) over rows with ts in (now - window, now].
 * Unlike fixed windows this is exact, so there is no 2x burst at a window edge.
 *
 * Lifecycle of a request's tokens:
 *   1. reserve(): estimate prompt tokens plus max_tokens, then check and insert in ONE
 *      `BEGIN IMMEDIATE` transaction. SQLite's write lock serialises concurrent
 *      reservations, even across several gateway processes sharing the DB file,
 *      so two requests can never both see headroom that only one of them fits.
 *   2. commit(): once the provider replies, replace the estimate with the actual
 *      `usage.total_tokens`, freeing over-reserved budget immediately.
 *   3. release(): if every provider failed, delete the reservation so the tenant
 *      is not charged for a request that never completed.
 *
 * Eviction: on every check the tenant's expired rows are deleted (bounded work,
 * served by the (tenant, ts) index), and sweep() purges every tenant periodically.
 * Tenant keys are stored only as SHA-256 hashes, never raw.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";

export interface RateLimiterOptions {
  dbPath: string;
  limitTokens?: number; // default 50,000
  windowMs?: number; // default 60,000
  now?: () => number; // injectable clock for tests
}

export type ReserveResult =
  | { allowed: true; reservationId: number; remaining: number }
  | { allowed: false; retryAfterMs: number; remaining: number; reason: "rate_limited" | "exceeds_limit" };

export const hashKey = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex");

export class TokenRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly stmt: {
    evict: StatementSync;
    sum: StatementSync;
    oldestFreeing: StatementSync;
    insert: StatementSync;
    update: StatementSync;
    remove: StatementSync;
    sweep: StatementSync;
  };

  constructor(opts: RateLimiterOptions) {
    this.limit = opts.limitTokens ?? 50_000;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;        -- readers do not block the writer
      PRAGMA synchronous = NORMAL;      -- durable enough for rate-limit state, much faster than FULL
      PRAGMA busy_timeout = 5000;       -- wait for the write lock instead of failing with SQLITE_BUSY
      CREATE TABLE IF NOT EXISTS token_usage (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant     TEXT    NOT NULL,
        ts_ms      INTEGER NOT NULL,
        tokens     INTEGER NOT NULL CHECK (tokens >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_tenant_ts ON token_usage (tenant, ts_ms);
    `);
    this.stmt = {
      evict: this.db.prepare("DELETE FROM token_usage WHERE tenant = ? AND ts_ms <= ?"),
      sum: this.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS used FROM token_usage WHERE tenant = ? AND ts_ms > ?"),
      oldestFreeing: this.db.prepare("SELECT ts_ms, tokens FROM token_usage WHERE tenant = ? AND ts_ms > ? ORDER BY ts_ms ASC"),
      insert: this.db.prepare("INSERT INTO token_usage (tenant, ts_ms, tokens) VALUES (?, ?, ?)"),
      update: this.db.prepare("UPDATE token_usage SET tokens = ? WHERE id = ?"),
      remove: this.db.prepare("DELETE FROM token_usage WHERE id = ?"),
      sweep: this.db.prepare("DELETE FROM token_usage WHERE ts_ms <= ?"),
    };
  }

  /** Atomically checks headroom and reserves `tokens` for the tenant. */
  reserve(apiKey: string, tokens: number): ReserveResult {
    const tenant = hashKey(apiKey);
    const cost = Math.max(0, Math.ceil(tokens));
    if (cost > this.limit) {
      // Even an empty window could never admit this request, so do not tell the client to retry.
      return { allowed: false, retryAfterMs: 0, remaining: this.limit, reason: "exceeds_limit" };
    }
    return this.transaction(() => {
      const now = this.now();
      const windowStart = now - this.windowMs;
      this.stmt.evict.run(tenant, windowStart);
      const used = Number((this.stmt.sum.get(tenant, windowStart) as { used: number }).used);
      if (used + cost > this.limit) {
        return { allowed: false, retryAfterMs: this.retryAfter(tenant, windowStart, used + cost - this.limit, now), remaining: Math.max(0, this.limit - used), reason: "rate_limited" };
      }
      const { lastInsertRowid } = this.stmt.insert.run(tenant, now, cost);
      return { allowed: true, reservationId: Number(lastInsertRowid), remaining: this.limit - used - cost };
    });
  }

  /** Replaces a reservation's estimate with the actual token count. */
  commit(reservationId: number, actualTokens: number): void {
    this.stmt.update.run(Math.max(0, Math.ceil(actualTokens)), reservationId);
  }

  /** Cancels a reservation, e.g. when every provider failed. */
  release(reservationId: number): void {
    this.stmt.remove.run(reservationId);
  }

  /** Current usage in the window (read-only). */
  usage(apiKey: string): number {
    const row = this.stmt.sum.get(hashKey(apiKey), this.now() - this.windowMs) as { used: number };
    return Number(row.used);
  }

  /** Global eviction of expired rows. Returns the number of rows removed. */
  sweep(): number {
    return Number(this.stmt.sweep.run(this.now() - this.windowMs).changes);
  }

  close(): void {
    this.db.close();
  }

  /** Time until enough old rows leave the window to free `deficit` tokens. */
  private retryAfter(tenant: string, windowStart: number, deficit: number, now: number): number {
    let freed = 0;
    for (const row of this.stmt.oldestFreeing.iterate(tenant, windowStart) as Iterable<{ ts_ms: number; tokens: number }>) {
      freed += Number(row.tokens);
      if (freed >= deficit) return Math.max(1, Number(row.ts_ms) + this.windowMs - now);
    }
    return this.windowMs;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * Cheap, dependency-free token estimate (~4 chars per token for English, plus
 * per-message overhead), plus the completion budget the caller asked for.
 * Reservations are deliberately pessimistic; commit() corrects them afterwards.
 */
export function estimateRequestTokens(body: { messages?: Array<{ content?: unknown }>; max_tokens?: number; max_completion_tokens?: number }, defaultCompletion = 1024): number {
  let chars = 0;
  for (const m of body.messages ?? []) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  }
  const prompt = Math.ceil(chars / 4) + 4 * (body.messages?.length ?? 0);
  const completion = body.max_completion_tokens ?? body.max_tokens ?? defaultCompletion;
  return prompt + completion;
}
