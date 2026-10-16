import { slideWindow } from "./quota";

/**
 * A sliding-window limit for routes with no member to count against (an invitation link opened or
 * accepted before anyone is signed in): kept in this API instance's memory, keyed by an opaque
 * value (a client address, or a token's SHA-256, never the token). Counting across instances needs
 * a Postgres table keyed by something other than a member (`request_quota` is per member), logged
 * in STATUS item 20 for Lane A.
 */
export class MemoryThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    /** Keys kept at most, so a flood of distinct keys cannot grow memory without bound. */
    readonly maxKeys = 10_000,
  ) {}

  /** Records one use of `key` now; seconds to wait when over the limit (nothing recorded), else null. */
  take(key: string, now: number = Date.now()): number | null {
    const previous = (this.hits.get(key) ?? []).map((at) => ({ at, amount: 1 }));
    const { recent, waitSeconds } = slideWindow(previous, 1, this.limit, this.windowMs, now);
    if (waitSeconds !== null) return waitSeconds;
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      // Drop the oldest key (Map keeps insertion order).
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    this.hits.delete(key);
    this.hits.set(key, [...recent.map((h) => h.at), now]);
    return null;
  }
}
