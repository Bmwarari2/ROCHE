import { HttpProblem } from "./problem";

/**
 * A per-user sliding-window limit for expensive routes (the hospital transfer pack builds a
 * snapshot and may decode a photo; S2). Held in this process's memory: each API instance limits on
 * its own, which bounds the work any one user can cause without a shared store. The key is opaque
 * (tenant user id and route), never personal data.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Records one use now; the number of seconds to wait when over the limit, otherwise null. */
  take(key: string, now: number = Date.now()): number | null {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(since);
    return null;
  }

  private prune(since: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= since)) this.hits.delete(key);
    }
  }
}

/** Throws 429 with Retry-After when the user is over the limit for this route. */
export function requireWithinLimit(limiter: RateLimiter, key: string): void {
  const wait = limiter.take(key);
  if (wait === null) return;
  const problem = new HttpProblem(
    429,
    "rate_limited",
    "Too many requests. Wait a moment and try again.",
    `Try again in ${wait} seconds.`,
  );
  problem.retryAfterSeconds = wait;
  throw problem;
}
