import { createHash } from "node:crypto";
import { auditEvent, type Transaction } from "@harbour/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Context } from "hono";
import type pg from "pg";
import type { AppEnv, TenantAccess } from "./context";
import type { HttpProblem } from "./problem";

/**
 * Audit trail writer (section 5.5). Every view of a care record, change, export, permission
 * refusal and sync event is appended to `audit_event`, which the database hash-chains per tenant.
 * Events carry opaque identifiers only; before and after states are stored as hashes.
 */

export interface AuditInput {
  readonly action: string;
  readonly outcome?: "success" | "denied" | "error";
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly reason?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly scope?: Record<string, unknown>;
  /**
   * Keys added to the scope (the given one, or by default the request's), never replacing it: for
   * example the outage a back-entry cites, beside the scope and locations that authorised it.
   */
  readonly scopeExtra?: Record<string, unknown>;
  readonly requestId?: string;
  readonly actorAuthUserId?: string;
  readonly ip?: string | null;
}

export function stateHash(state: unknown): string | null {
  if (state === undefined) return null;
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function scopeOf(access: TenantAccess | null, input: AuditInput) {
  // By default, the scope the request ran under: its permission's (ADR-0071).
  const base =
    input.scope ??
    (access ? { scope: access.context.scope, locations: access.context.locationIds } : null);
  if (!input.scopeExtra || Object.keys(input.scopeExtra).length === 0) return base;
  return { ...(base ?? {}), ...input.scopeExtra };
}

function values(access: TenantAccess | null, input: AuditInput) {
  return {
    tenantId: access?.tenantId ?? null,
    actorTenantUserId: access?.tenantUserId ?? null,
    actorAuthUserId: access?.session.authUserId ?? input.actorAuthUserId ?? null,
    actorRoleKeys: access ? [...access.effective.roleKeys] : null,
    action: input.action,
    outcome: input.outcome ?? "success",
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    scope: scopeOf(access, input),
    ip: access?.ip ?? input.ip ?? null,
    deviceId: access?.deviceId ?? null,
    requestId: input.requestId ?? null,
    reason: input.reason ?? null,
    beforeHash: stateHash(input.before),
    afterHash: stateHash(input.after),
  };
}

/** Appends an audit event inside the caller's transaction (it commits or rolls back with the change). */
export async function auditInTx(
  tx: Transaction,
  access: TenantAccess,
  input: AuditInput,
): Promise<void> {
  await tx.insert(auditEvent).values(values(access, input));
}

/**
 * Appends several audit events in one statement inside the caller's transaction (for example one
 * per record a bulk import creates), in the order given, so the hash chain follows that order.
 */
export async function auditManyInTx(
  tx: Transaction,
  access: TenantAccess,
  inputs: readonly AuditInput[],
): Promise<void> {
  const chunk = 500;
  for (let start = 0; start < inputs.length; start += chunk) {
    await tx
      .insert(auditEvent)
      .values(inputs.slice(start, start + chunk).map((input) => values(access, input)));
  }
}

/**
 * Appends an audit event in its own transaction, for refusals and events that must be kept even
 * when the request fails. Without an access context the event is a platform event (NULL tenant).
 */
export async function writeAudit(
  pool: pg.Pool,
  access: TenantAccess | null,
  input: AuditInput,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (access) {
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.scope', 'none', true), set_config('app.location_ids', '', true)`,
        [access.tenantId, access.tenantUserId],
      );
    }
    await drizzle(client).insert(auditEvent).values(values(access, input));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A refusal decided inside a transaction whose audit row must survive it: thrown in the
 * transaction, and turned into the problem by `withAuditedRefusal` after the transaction has
 * ended and released its connection, so writing the audit never needs a second connection while
 * one is held (S-L7).
 */
export class AuditedRefusal extends Error {
  constructor(
    readonly problem: HttpProblem,
    readonly audit: AuditInput,
  ) {
    super(problem.message);
  }
}

/** Runs a transaction and, if it ends in an `AuditedRefusal`, records the refusal, then throws. */
export async function withAuditedRefusal<T>(
  c: Context<AppEnv>,
  access: TenantAccess,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof AuditedRefusal)) throw error;
    await writeAudit(c.get("services").appPool, access, {
      ...error.audit,
      requestId: c.get("requestId"),
    });
    throw error.problem;
  }
}
