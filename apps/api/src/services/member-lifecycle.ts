import type { SignInState } from "@harbour/contracts";
import {
  auditEvent,
  type Database,
  type Transaction,
  task,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { writeAudit } from "../http/audit";
import { ACCOUNT_DELETION_TASK_KIND } from "./account-deletion";

/**
 * The erasure step of the member lifecycle (H-566; platform.md, Members). Once a person asked for
 * their account to be deleted and no membership of their sign-in, in any organisation, is invited
 * or active (`app.sign_ins_due_for_erasure`), their sign-in identity is erased: the Better Auth
 * user goes, and with it (by cascade) their sessions, password hash, passkeys and second-factor
 * secret, and any verification addressed to them. Each membership then loses its link to the
 * sign-in; an ended one also loses its address, which is replaced by an opaque placeholder. The
 * member row, display name and job title stay, so care records remain attributable (Regulation
 * 17), and the staff file follows `staff_file` retention. Every open account deletion request of
 * those memberships closes with the outcome, audited by opaque id. Idempotent: the sign-in is
 * deleted first, so a run stopped part-way is finished by the next one.
 */

export const SIGN_IN_ERASED_ACTION = "platform.member.sign_in_erased";
export const DELETION_COMPLETED_ACTION = "platform.account_deletion.completed";
/** The outcomes an account deletion request closes with. */
export type DeletionOutcome = "sign_in_erased" | "membership_ended_sign_in_kept";

export interface ErasureDeps {
  readonly appPool: pg.Pool;
  readonly appDb: Database;
  readonly authPool: pg.Pool;
}

const system = (tenantId: string) => ({
  tenantId,
  userId: null,
  scope: "tenant" as const,
  locationIds: [] as string[],
});

/** Whether the sign-in is due for erasure now. */
export async function signInDueForErasure(pool: pg.Pool, authUserId: string): Promise<boolean> {
  const due = await pool.query(
    "SELECT 1 FROM app.sign_ins_due_for_erasure() AS id WHERE id = $1 LIMIT 1",
    [authUserId],
  );
  return (due.rowCount ?? 0) > 0;
}

/** Whether the person still has an invited or active membership in another organisation. */
export async function activeElsewhere(
  pool: pg.Pool,
  authUserId: string,
  tenantId: string,
): Promise<boolean> {
  const rows = await pool.query<{ tenant_id: string; status: string }>(
    "SELECT tenant_id, status FROM app.memberships_of_sign_in($1)",
    [authUserId],
  );
  return rows.rows.some(
    (r) => r.tenant_id !== tenantId && (r.status === "active" || r.status === "invited"),
  );
}

/**
 * Closes the member's open account deletion requests with the outcome, as the system for the
 * organisation, audited. Returns how many closed.
 */
export async function closeDeletionRequests(
  tx: Transaction,
  tenantId: string,
  memberId: string,
  outcome: DeletionOutcome,
  requestId?: string,
): Promise<number> {
  const closed = await tx
    .update(task)
    .set({ status: "done", statusReason: outcome, completedAt: new Date() })
    .where(
      and(
        eq(task.kind, ACCOUNT_DELETION_TASK_KIND),
        eq(task.sourceType, "tenant_user"),
        eq(task.sourceId, memberId),
        inArray(task.status, ["open", "in_progress"]),
        isNull(task.deletedAt),
      ),
    )
    .returning({ id: task.id });
  for (const row of closed) {
    await tx.insert(auditEvent).values({
      tenantId,
      actorAuthUserId: "system",
      action: DELETION_COMPLETED_ACTION,
      resourceType: "task",
      resourceId: row.id,
      reason: outcome,
      scope: { memberId, outcome },
      requestId: requestId ?? null,
    });
  }
  return closed.length;
}

/**
 * Erases the sign-in when it is due (see above); false, changing nothing, when it is not. Safe to
 * run again.
 */
export async function eraseSignIn(
  deps: ErasureDeps,
  authUserId: string,
  requestId?: string,
): Promise<boolean> {
  if (!(await signInDueForErasure(deps.appPool, authUserId))) return false;
  const memberships = await deps.appPool.query<{ tenant_id: string; tenant_user_id: string }>(
    "SELECT tenant_id, tenant_user_id FROM app.memberships_of_sign_in($1)",
    [authUserId],
  );
  // The sign-in first: its sessions, password, passkeys and second factor cascade with it.
  const auth = await deps.authPool.connect();
  let address: string | null = null;
  try {
    await auth.query("BEGIN");
    const found = await auth.query<{ email: string }>(
      'SELECT email FROM auth."user" WHERE id = $1 FOR UPDATE',
      [authUserId],
    );
    address = found.rows[0]?.email ?? null;
    if (address !== null) {
      await auth.query("DELETE FROM auth.verification WHERE identifier = $1", [address]);
    }
    await auth.query('DELETE FROM auth."user" WHERE id = $1', [authUserId]);
    await auth.query("COMMIT");
  } catch (error) {
    await auth.query("ROLLBACK");
    throw error;
  } finally {
    auth.release();
  }
  await writeAudit(deps.appPool, null, {
    action: SIGN_IN_ERASED_ACTION,
    actorAuthUserId: "system",
    resourceType: "auth_user",
    resourceId: authUserId,
    reason: "account_deletion_requested",
    scope: { memberships: memberships.rows.length, signInFound: address !== null },
    ...(requestId ? { requestId } : {}),
  });
  for (const m of memberships.rows) {
    await withRequestContext(deps.appDb, system(m.tenant_id), async (tx) => {
      await tx
        .update(tenantUser)
        .set({
          authUserId: null,
          signInErasedAt: sql`now()`,
          // An ended membership keeps no address; a placeholder keeps the column's uniqueness.
          email: sql`CASE WHEN ${tenantUser.status} = 'left'
            THEN ${tenantUser.id}::text || '@erased.invalid' ELSE ${tenantUser.email} END`,
        })
        .where(and(eq(tenantUser.id, m.tenant_user_id), eq(tenantUser.authUserId, authUserId)));
      await tx.insert(auditEvent).values({
        tenantId: m.tenant_id,
        actorAuthUserId: "system",
        action: SIGN_IN_ERASED_ACTION,
        resourceType: "tenant_user",
        resourceId: m.tenant_user_id,
        reason: "account_deletion_requested",
        scope: { outcome: "sign_in_erased" },
        requestId: requestId ?? null,
      });
      await closeDeletionRequests(tx, m.tenant_id, m.tenant_user_id, "sign_in_erased", requestId);
    });
  }
  return true;
}

/**
 * The sweep (worker): erases every sign-in due, so a membership ended in another organisation, or
 * by the leaver process, completes the person's request within
 * `account_deletion.confirmation_days`. Returns how many were erased.
 */
export async function sweepSignInErasures(
  deps: ErasureDeps & { readonly workerPool: pg.Pool },
): Promise<number> {
  const due = await deps.workerPool.query<{ id: string }>(
    "SELECT id FROM app.sign_ins_due_for_erasure() AS id",
  );
  let erased = 0;
  for (const { id } of due.rows) {
    if (await eraseSignIn(deps, id)) erased += 1;
  }
  return erased;
}

/** The sign-in state the manager sees for a membership. */
export function signInStateOf(row: {
  readonly authUserId: string | null;
  readonly signInErasedAt: Date | null;
  readonly elsewhere: boolean;
}): SignInState {
  if (row.signInErasedAt) return "erased";
  if (!row.authUserId) return "none";
  return row.elsewhere ? "kept_other_organisation" : "kept";
}
