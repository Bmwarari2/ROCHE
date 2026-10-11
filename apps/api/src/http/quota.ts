import { HttpProblem } from "./problem";

/**
 * A per-user quota on routes a device calls on its own (security review round 4, M4): deletion
 * records and device reports. The API has no shared rate limiter for /v1 routes (Better Auth
 * throttles only its own sign-in routes, and the web application firewall limits each address), so
 * this is a sliding window kept in the process: with several API tasks a user may reach the limit
 * once per task, which still bounds the audit rows a stolen token can write. A refusal is a 429 with
 * Retry-After, which the device reads as "try again later".
 */
export class PerUserQuota {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Counts one request for `key`; throws a 429 problem when the window is full. */
  take(key: string, now = Date.now()): void {
    const since = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.max) {
      const oldest = recent[0] ?? now;
      throw new QuotaExceeded(Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)));
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Keep the map small: forget keys whose window has passed.
    if (this.hits.size > 10_000) {
      for (const [k, times] of this.hits) {
        if ((times.at(-1) ?? 0) <= since) this.hits.delete(k);
      }
    }
  }
}

export class QuotaExceeded extends HttpProblem {
  constructor(readonly retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many requests. Try again in a few minutes.");
    this.name = "QuotaExceeded";
  }
}
