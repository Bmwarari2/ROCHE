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
 * - `scope`: 'tenant' (all people), 'locations' (people at `locationIds`), 'assigned' (assigned
 *   people and open break-glass records only) or 'none'.
 */
export interface RequestContext {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly scope: "tenant" | "locations" | "assigned" | "none";
  readonly locationIds: readonly string[];
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
}

export function createPool(connectionString: string, options: pg.PoolConfig = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Application logs use opaque ids only; never echo query parameters (section 5.3).
    application_name: "harbour",
    ...options,
  });
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
      set_config('app.location_ids', ${ctx.locationIds.join(",")}, true)
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
