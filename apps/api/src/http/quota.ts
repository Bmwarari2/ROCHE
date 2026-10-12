import { requestQuota, type Transaction } from "@harbour/db";
import { and, eq, sql } from "drizzle-orm";
import { HttpProblem } from "./problem";

/**
 * Per-user limits on what a member's requests may cost (security reviews round 4, M4 and round 5,
 * S-M2): deletion records, entry ids, device reports and refusal copies a device sends on its own,
 * and the transfer pack and handover compile routes. Each limit is a sliding window kept in
 * Postgres (`request_quota`, one row per member and limit, rewritten under a row lock), so it holds
 * across every API instance (care.md section 6, Device integrity part 7). A refusal is a 429 with
 * Retry-After, which the device reads as "try again later".
 *
 * Each request counts as one, or as `amount` (for example the entry ids a deletion lists). Call in
 * a transaction in the member's own view (or the system's): row-level security lets a member count
 * only against their own limits. A request whose transaction rolls back is not counted.
 */

export interface QuotaHit {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly amount: number;
}

/**
 * The sliding window (pure): the hits still inside it, and how many seconds to wait when `amount`
 * more would pass `max`, else null.
 */
export function slideWindow(
  hits: readonly QuotaHit[],
  amount: number,
  max: number,
  windowMs: number,
  now: number,
): { readonly recent: QuotaHit[]; readonly waitSeconds: number | null } {
  const since = now - windowMs;
  const recent = hits.filter((h) => h.at > since).sort((a, b) => a.at - b.at);
  const used = recent.reduce((sum, h) => sum + h.amount, 0);
  if (used + amount <= max) return { recent, waitSeconds: null };
  const oldest = recent[0]?.at ?? now;
  return { recent, waitSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
}

function readHits(value: unknown): QuotaHit[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((h: unknown) => {
    const hit = h as { at?: unknown; amount?: unknown } | null;
    return typeof hit?.at === "number" && typeof hit.amount === "number"
      ? [{ at: hit.at, amount: hit.amount }]
      : [];
  });
}

/** The member's hits under one limit, with the row locked until the transaction ends. */
async function lockedHits(
  tx: Transaction,
  quota: string,
  tenantUserId: string,
): Promise<QuotaHit[]> {
  await tx.insert(requestQuota).values({ quota, tenantUserId }).onConflictDoNothing();
  const [row] = await tx
    .select({ hits: requestQuota.hits })
    .from(requestQuota)
    .where(and(eq(requestQuota.quota, quota), eq(requestQuota.tenantUserId, tenantUserId)))
    .for("update");
  return readHits(row?.hits);
}

async function saveHits(
  tx: Transaction,
  quota: string,
  tenantUserId: string,
  hits: readonly QuotaHit[],
): Promise<void> {
  await tx
    .update(requestQuota)
    .set({ hits: [...hits], updatedAt: sql`now()` })
    .where(and(eq(requestQuota.quota, quota), eq(requestQuota.tenantUserId, tenantUserId)));
}

/** A member's limit, counted in Postgres. */
export class PerUserQuota {
  constructor(
    readonly name: string,
    readonly max: number,
    readonly windowMs: number,
  ) {}

  /** Throws the 429 problem `take` would, without counting anything. */
  async check(tx: Transaction, tenantUserId: string, amount = 1, now = Date.now()): Promise<void> {
    const { waitSeconds } = slideWindow(
      await lockedHits(tx, this.name, tenantUserId),
      amount,
      this.max,
      this.windowMs,
      now,
    );
    if (waitSeconds !== null) throw new QuotaExceeded(waitSeconds);
  }

  /** Counts `amount` for the member; throws a 429 problem when it would pass the limit. */
  async take(tx: Transaction, tenantUserId: string, amount = 1, now = Date.now()): Promise<void> {
    const { recent, waitSeconds } = slideWindow(
      await lockedHits(tx, this.name, tenantUserId),
      amount,
      this.max,
      this.windowMs,
      now,
    );
    if (waitSeconds !== null) throw new QuotaExceeded(waitSeconds);
    await saveHits(
      tx,
      this.name,
      tenantUserId,
      amount > 0 ? [...recent, { at: now, amount }] : recent,
    );
  }

  /**
   * Counts one request, answering how many seconds to wait when it would pass the limit (nothing
   * is counted then), else null.
   */
  async attempt(tx: Transaction, tenantUserId: string, now = Date.now()): Promise<number | null> {
    const { recent, waitSeconds } = slideWindow(
      await lockedHits(tx, this.name, tenantUserId),
      1,
      this.max,
      this.windowMs,
      now,
    );
    if (waitSeconds !== null) return waitSeconds;
    await saveHits(tx, this.name, tenantUserId, [...recent, { at: now, amount: 1 }]);
    return null;
  }
}

export class QuotaExceeded extends HttpProblem {
  constructor(override readonly retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many requests. Try again in a few minutes.");
    this.name = "QuotaExceeded";
  }
}
