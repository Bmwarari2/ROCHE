import type { SignInState } from "@harbour/contracts";
import { auditEvent, type Database, type Transaction, task, withRequestContext } from "@harbour/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { writeAudit } from "../http/audit";
import type { Logger } from "../logger";
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

/** Whether the sign-in is due for erasure now (`app.sign_in_due_for_erasure`). */
export async function signInDueForErasure(pool: pg.Pool, authUserId: string): Promise<boolean> {
  const due = await pool.query<{ due: boolean }>("SELECT app.sign_in_due_for_erasure($1) AS due", [
    authUserId,
  ]);
  return due.rows[0]?.due === true;
}

/**
 * The states of the person's memberships of other onboarding or active organisations: `active`
 * when one is invited or active (their sessions are kept, H-354), `held` when one is only
 * suspended (their sign-in is kept, H-1393), else none.
 */
export async function membershipElsewhere(
  pool: pg.Pool,
  authUserId: string,
  tenantId: string,
): Promise<"active" | "held" | "none"> {
  const rows = await pool.query<{ s: string }>(
    "SELECT s FROM app.other_membership_states($1, $2) AS s",
    [authUserId, tenantId],
  );
  const states = rows.rows.map((r) => r.s);
  if (states.some((x) => x === "active" || x === "invited")) return "active";
  return states.includes("suspended") ? "held" : "none";
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
 * Erases the sign-in when it is due (see above); false, changing nothing, when it is not. Each
 * membership is marked first, so a run stopped part-way is due again and finished by the next one
 * (security review M2); events are written only for what changed (L4).
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
  for (const m of memberships.rows) {
    await withRequestContext(deps.appDb, system(m.tenant_id), (tx) =>
      tx.execute(
        sql`SELECT app.mark_sign_in_erased(${m.tenant_user_id}::uuid, ${authUserId}, false)`,
      ),
    );
  }
  // The sign-in: its sessions, password, passkeys and second factor cascade with it.
  const auth = await deps.authPool.connect();
  let deleted = 0;
  try {
    await auth.query("BEGIN");
    const found = await auth.query<{ email: string }>(
      'SELECT email FROM auth."user" WHERE id = $1 FOR UPDATE',
      [authUserId],
    );
    const address = found.rows[0]?.email;
    if (address !== undefined) {
      await auth.query("DELETE FROM auth.verification WHERE identifier = $1", [address]);
      deleted =
        (await auth.query('DELETE FROM auth."user" WHERE id = $1', [authUserId])).rowCount ?? 0;
    }
    await auth.query("COMMIT");
  } catch (error) {
    await auth.query("ROLLBACK");
    throw error;
  } finally {
    auth.release();
  }
  if (deleted > 0) {
    await writeAudit(deps.appPool, null, {
      action: SIGN_IN_ERASED_ACTION,
      actorAuthUserId: "system",
      resourceType: "auth_user",
      resourceId: authUserId,
      reason: "account_deletion_requested",
      scope: { memberships: memberships.rows.length },
      ...(requestId ? { requestId } : {}),
    });
  }
  for (const m of memberships.rows) {
    await withRequestContext(deps.appDb, system(m.tenant_id), async (tx) => {
      const changed = await tx.execute<{ changed: boolean }>(
        sql`SELECT app.mark_sign_in_erased(${m.tenant_user_id}::uuid, ${authUserId}, true) AS changed`,
      );
      if (changed.rows[0]?.changed !== true) return;
      await tx.insert(auditEvent).values({
        tenantId: m.tenant_id,
        actorAuthUserId: "system",
        action: SIGN_IN_ERASED_ACTION,
        resourceType: "tenant_user",
        resourceId: m.tenant_user_id,
        reason: "account_deletion_requested",
        // The erased sign-in's opaque id, so earlier events naming only it stay traceable to the
        // member (clinical review L1).
        scope: { outcome: "sign_in_erased", authUserId },
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
 * `account_deletion.confirmation_days`, and finishes any erasure stopped part-way. One failure
 * never stops the rest (security review L5). Returns how many were erased.
 */
export async function sweepSignInErasures(
  deps: ErasureDeps & { readonly workerPool: pg.Pool; readonly logger?: Logger },
): Promise<number> {
  const due = await deps.workerPool.query<{ id: string }>(
    "SELECT id FROM app.sign_ins_due_for_erasure() AS id",
  );
  let erased = 0;
  for (const { id } of due.rows) {
    try {
      if (await eraseSignIn(deps, id)) erased += 1;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      deps.logger?.error(
        {
          event: "member.sign_in_erasure.failed",
          code: typeof code === "string" ? code : "unknown",
        },
        "sign-in erasure failed",
      );
    }
  }
  return erased;
}

/** The sign-in state the manager sees for a membership. */
export function signInStateOf(row: {
  readonly authUserId: string | null;
  readonly signInErasedAt: Date | null;
  readonly elsewhere: boolean;
}): SignInState {
  if (row.signInErasedAt && !row.authUserId) return "erased";
  if (!row.authUserId) return "none";
  return row.elsewhere ? "kept_other_organisation" : "kept";
}
