import { withRequestContext } from "@harbour/db";
import type { TenantAccess } from "./context";
import { HttpProblem } from "./problem";
import { PerUserQuota } from "./quota";

type Db = Parameters<typeof withRequestContext>[0];

/**
 * A per-user sliding-window limit for expensive routes (the hospital transfer pack builds a
 * snapshot and may decode a photo, S2; compiling a handover). Kept in Postgres with the other
 * per-user limits (`PerUserQuota`, `request_quota`), so every API instance counts against the same
 * window (care.md section 6, Device integrity part 7). The key is the member's opaque id and the
 * limit's name, never personal data.
 */
export class RateLimiter {
  private readonly quota: PerUserQuota;

  constructor(
    readonly name: string,
    readonly limit: number,
    readonly windowMs: number,
  ) {
    this.quota = new PerUserQuota(name, limit, windowMs);
  }

  /**
   * Records one use now, in the member's own view; the number of seconds to wait when over the
   * limit (nothing is recorded then), otherwise null.
   */
  take(db: Db, access: TenantAccess, now: number = Date.now()): Promise<number | null> {
    // The member's own view: their quota rows only, whatever the route's scope (ADR-0071).
    return withRequestContext(db, { ...access.context, scope: "none", locationIds: [] }, (tx) =>
      this.quota.attempt(tx, access.tenantUserId, now),
    );
  }
}

/** Throws 429 with Retry-After when the member is over the limit for this route. */
export async function requireWithinLimit(
  db: Db,
  access: TenantAccess,
  limiter: RateLimiter,
): Promise<void> {
  const wait = await limiter.take(db, access);
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
