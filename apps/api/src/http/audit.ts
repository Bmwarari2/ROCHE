import { createHash } from "node:crypto";
import { auditEvent, type Transaction } from "@harbour/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { TenantAccess } from "./context";

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
  readonly requestId?: string;
  readonly actorAuthUserId?: string;
  readonly ip?: string | null;
}

export function stateHash(state: unknown): string | null {
  if (state === undefined) return null;
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
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
    scope:
      input.scope ??
      (access ? { scope: access.effective.scope, locations: access.effective.locationIds } : null),
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
