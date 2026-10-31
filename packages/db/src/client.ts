import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index";

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Who the current request acts as, and on whom. Every database access by the API happens inside
 * `withRequestContext`, which sets these as transaction-local settings read by row-level security.
 * - `tenantId`: the tenant the request is for (required).
 * - `userId`: the acting tenant_user id, or null for system jobs.
 * - `scope`: 'tenant' (all people), 'locations' (people at `locationIds`), 'assigned' (people the
 *   user is assigned to) or 'none'.
 * - `includesAssigned`: a 'locations' scope also reaches the people the user is assigned to
 *   (always so for 'assigned'); `includesBreakGlass`: the scope also reaches the people the user
 *   opened by break-glass. Both default to false, which fails closed (ADR-0071 review round 1).
 */
export interface RequestContext {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly scope: "tenant" | "locations" | "assigned" | "none";
  readonly locationIds: readonly string[];
  readonly includesAssigned?: boolean;
  readonly includesBreakGlass?: boolean;
  /**
   * A request opened by an evidence pack link (`/p/evidence`, migration 0058): no member, scope
   * 'none', and row-level security holds it to this link and its pack alone.
   */
  readonly evidenceLink?: { readonly linkId: string; readonly packId: string };
  /**
   * A family portal session (ADR-0061, migration 0061): a member with scope 'none' whose feed rows
   * open only through `app.family_can_see`, for the contacts their `family_portal_user` links name.
   */
  readonly family?: boolean;
  /**
   * A public speak-up request (`/p/speak-up`, ADR-0089, migration 0086): no member, scope 'none'.
   * It may raise an anonymous concern, and with an anonymous concern's reply token hash (SHA-256,
   * hex) it reads and replies to that one concern alone.
   */
  readonly speakUp?: { readonly replyTokenHash: string | null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidRequestContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestContextError";
  }
}

export function assertValidContext(ctx: RequestContext): void {
  if (!UUID.test(ctx.tenantId)) throw new InvalidRequestContextError("tenantId is not a UUID");
  if (ctx.userId !== null && !UUID.test(ctx.userId)) {
    throw new InvalidRequestContextError("userId is not a UUID");
  }
  for (const id of ctx.locationIds) {
    if (!UUID.test(id)) throw new InvalidRequestContextError("locationIds contains a non-UUID");
  }
  if (!["tenant", "locations", "assigned", "none"].includes(ctx.scope)) {
    throw new InvalidRequestContextError("scope is not recognised");
  }
  if (ctx.evidenceLink) {
    const { linkId, packId } = ctx.evidenceLink;
    if (!UUID.test(linkId) || !UUID.test(packId)) {
      throw new InvalidRequestContextError("evidenceLink is not a pair of UUIDs");
    }
    if (ctx.userId !== null || ctx.scope !== "none") {
      throw new InvalidRequestContextError("a link session has no member and scope 'none'");
    }
  }
  if (ctx.speakUp) {
    const hash = ctx.speakUp.replyTokenHash;
    if (hash !== null && !/^[0-9a-f]{64}$/.test(hash)) {
      throw new InvalidRequestContextError("speakUp.replyTokenHash is not a SHA-256 hex digest");
    }
    if (ctx.userId !== null || ctx.scope !== "none" || ctx.evidenceLink || ctx.family) {
      throw new InvalidRequestContextError("a speak-up request has no member and scope 'none'");
    }
  }
  if (ctx.family && (ctx.userId === null || ctx.scope !== "none" || ctx.evidenceLink)) {
    throw new InvalidRequestContextError("a family session has a member and scope 'none'");
  }
}

/** An error on a connection waiting in the pool, with the Postgres code when there is one. */
export type IdleConnectionError = Error & { readonly code?: string };

/**
 * A connection pool. An idle connection can fail between queries (a failover, a restart, an
 * administrator ending sessions); the pool then discards it and opens a new one when needed, and
 * reports the error here. Without a listener Node would treat it as unhandled and stop the process.
 */
export function createPool(
  connectionString: string,
  options: pg.PoolConfig = {},
  onIdleError: (error: IdleConnectionError) => void = () => {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Application logs use opaque ids only; never echo query parameters (section 5.3).
    application_name: "harbour",
    ...options,
  });
  pool.on("error", (error: IdleConnectionError) => onIdleError(error));
  return pool;
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

/** Sets the row-level security context for the current transaction only. */
export async function applyRequestContext(tx: Transaction | Database, ctx: RequestContext) {
  assertValidContext(ctx);
  await tx.execute(sql`
    SELECT
      set_config('app.tenant_id', ${ctx.tenantId}, true),
      set_config('app.user_id', ${ctx.userId ?? ""}, true),
      set_config('app.scope', ${ctx.scope}, true),
      set_config('app.location_ids', ${ctx.locationIds.join(",")}, true),
      set_config('app.scope_assigned', ${ctx.includesAssigned === true ? "true" : ""}, true),
      set_config('app.scope_break_glass', ${ctx.includesBreakGlass === true ? "true" : ""}, true),
      set_config('app.link_id', ${ctx.evidenceLink?.linkId ?? ""}, true),
      set_config('app.link_pack_id', ${ctx.evidenceLink?.packId ?? ""}, true),
      set_config('app.family', ${ctx.family === true ? "true" : ""}, true),
      set_config('app.speak_up', ${ctx.speakUp ? "true" : ""}, true),
      set_config('app.speak_up_token', ${ctx.speakUp?.replyTokenHash ?? ""}, true)
  `);
}

/**
 * Runs `fn` in a transaction with the request context applied. This is the only way the API
 * touches tenant data; the settings vanish at commit or rollback, so a pooled connection never
 * carries one request's tenant into the next.
 */
export async function withRequestContext<T>(
  db: Database,
  ctx: RequestContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await applyRequestContext(tx, ctx);
    return fn(tx);
  });
}
