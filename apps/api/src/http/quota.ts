import { HttpProblem } from "./problem";

/**
 * A per-user quota on routes a device calls on its own (security reviews round 4, M4 and round 5,
 * S-M2): deletion records and device reports. The API has no shared rate limiter for /v1 routes
 * (Better Auth throttles only its own sign-in routes, and the web application firewall limits each
 * address), so this is a sliding window kept in the process: with several API tasks a user may
 * reach the limit once per task, which still bounds the audit rows a stolen token can write. A
 * refusal is a 429 with Retry-After, which the device reads as "try again later".
 *
 * Each request counts as one, or as `amount` (for example the entry ids a deletion lists).
 */
export class PerUserQuota {
  private readonly hits = new Map<
    string,
    Array<{ readonly at: number; readonly amount: number }>
  >();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Throws the 429 problem `take` would, without counting anything. */
  check(key: string, amount = 1, now = Date.now()): void {
    this.recent(key, amount, now);
  }

  /** Counts `amount` for `key`; throws a 429 problem when it would pass the window's limit. */
  take(key: string, amount = 1, now = Date.now()): void {
    const recent = this.recent(key, amount, now);
    if (amount > 0) recent.push({ at: now, amount });
    this.hits.set(key, recent);
    // Keep the map small: forget keys whose window has passed.
    if (this.hits.size > 10_000) {
      for (const [k, entries] of this.hits) {
        if ((entries.at(-1)?.at ?? 0) <= now - this.windowMs) this.hits.delete(k);
      }
    }
  }

  /** The key's hits inside the window; throws when `amount` more would pass the limit. */
  private recent(key: string, amount: number, now: number) {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((h) => h.at > since);
    const used = recent.reduce((sum, h) => sum + h.amount, 0);
    if (used + amount > this.max) {
      const oldest = recent[0]?.at ?? now;
      throw new QuotaExceeded(Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)));
    }
    return recent;
  }
}

export class QuotaExceeded extends HttpProblem {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many requests. Try again in a few minutes.");
    this.name = "QuotaExceeded";
  }
}
