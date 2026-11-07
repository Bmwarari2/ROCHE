import {
  auditEvent,
  authSession,
  authUser,
  authVerification,
  type Database,
  task,
  withRequestContext,
} from "@harbour/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Logger } from "../logger";
import { ACCOUNT_DELETION_TASK_KIND } from "./account-deletion";

/**
 * Erasing a sign-in identity (H-566; platform.md, Members). The route
 * (`POST /v1/members/{id}/sign-in/erase`) erases an ended member's sign-in when a manager asks;
 * the nightly sweep (`sweepSignInErasures`) erases every sign-in due without one, so a member's
 * account deletion request completes within `account_deletion.confirmation_days`: the member
 * asked, that membership has ended, and no membership of the sign-in in an onboarding or active
 * organisation is invited, active or suspended (`app.sign_ins_due_for_erasure`, migration 0149).
 */

export const ERASED_ACTION = "platform.member.sign_in_erased";
const DELETION_COMPLETED = "platform.account_deletion.completed";

/** Exactly what goes, and what stays, for the audit event written before the identity goes. */
export const ERASED_SCOPE = {
  removed: [
    "sign_in_address",
    "password_hash",
    "passkeys",
    "totp_secret_and_backup_codes",
    "sessions",
    "verification_tokens",
    "member_sign_in_link",
  ],
  kept: ["member_row"],
} as const;

/**
 * Deletes a sign-in identity in one transaction of the auth role: its verification tokens (by
 * address; any naming the user, such as password resets and passkey challenges; and the
 * second-factor records of its sessions), then the user, whose sessions,
 * accounts (password hash), TOTP secret and backup codes, and passkeys go with it (foreign keys on
 * delete cascade). A sign-in already gone deletes nothing.
 */
export async function eraseSignInIdentity(authPool: pg.Pool, authUserId: string): Promise<void> {
  const client = await authPool.connect();
  try {
    await client.query("BEGIN");
    const auth = drizzle(client);
    const [user] = await auth
      .select({ email: authUser.email })
      .from(authUser)
      .where(eq(authUser.id, authUserId))
      .for("update");
    if (user) {
      const sessions = await auth
        .select({ id: authSession.id })
        .from(authSession)
        .where(eq(authSession.userId, authUserId));
      await auth.delete(authVerification).where(
        or(
          eq(authVerification.identifier, user.email),
          // Password reset tokens hold the user id; passkey challenges hold it inside their
          // JSON (they also expire within minutes).
          sql`strpos(${authVerification.value}, ${authUserId}) > 0`,
          ...sessions.map((x) => eq(authVerification.identifier, `session-factor:${x.id}`)),
        ),
      );
      await auth.delete(authUser).where(eq(authUser.id, authUserId));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const system = (tenantId: string) => ({
  tenantId,
  userId: null,
  scope: "tenant" as const,
  locationIds: [] as string[],
});

/**
 * The nightly sweep. For each ended membership whose sign-in is due, audited first (by the system,
 * opaque ids only): on the worker's own connection, in one transaction, the database removes the
 * member row's link (`app.change_membership`, which checks it is due again and holds the sign-in's
 * lock until the end, so an invitation accepted for the same sign-in waits), then the identity is
 * deleted, then the transaction commits; if the deletion fails the link is restored. An open
 * account deletion request then closes as done. The membership that asked comes last, so a sweep
 * stopped part-way finds the sign-in due next time; a failure is audited and never stops the rest.
 * Returns how many memberships were unlinked.
 */
export async function sweepSignInErasures(deps: {
  readonly workerPool: pg.Pool;
  readonly appDb: Database;
  readonly authPool: pg.Pool;
  readonly logger?: Logger;
}): Promise<number> {
  const due = await deps.workerPool.query<{
    tenant_id: string;
    tenant_user_id: string;
    auth_user_id: string;
  }>("SELECT tenant_id, tenant_user_id, auth_user_id FROM app.sign_ins_due_for_erasure()");
  let unlinked = 0;
  const audit = (row: (typeof due.rows)[number], values: Partial<typeof auditEvent.$inferInsert>) =>
    withRequestContext(deps.appDb, system(row.tenant_id), (tx) =>
      tx.insert(auditEvent).values({
        tenantId: row.tenant_id,
        actorAuthUserId: "system",
        action: ERASED_ACTION,
        resourceType: "tenant_user",
        resourceId: row.tenant_user_id,
        ...values,
      }),
    );
  for (const row of due.rows) {
    try {
      await audit(row, {
        reason: "account_deletion_request",
        scope: { ...ERASED_SCOPE, by: "sweep" },
      });
      const client = await deps.workerPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true),
                  set_config('app.user_id', '', true), set_config('app.location_ids', '', true)`,
          [row.tenant_id],
        );
        await client.query("SELECT app.change_membership($1::uuid, 'unlink_sign_in')", [
          row.tenant_user_id,
        ]);
        await eraseSignInIdentity(deps.authPool, row.auth_user_id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await withRequestContext(deps.appDb, system(row.tenant_id), async (tx) => {
        const closed = await tx
          .update(task)
          .set({ status: "done", statusReason: "sign_in_erased", completedAt: new Date() })
          .where(
            and(
              eq(task.kind, ACCOUNT_DELETION_TASK_KIND),
              eq(task.sourceType, "tenant_user"),
              eq(task.sourceId, row.tenant_user_id),
              inArray(task.status, ["open", "in_progress"]),
              isNull(task.deletedAt),
            ),
          )
          .returning({ id: task.id });
        for (const t of closed) {
          await tx.insert(auditEvent).values({
            tenantId: row.tenant_id,
            actorAuthUserId: "system",
            action: DELETION_COMPLETED,
            resourceType: "task",
            resourceId: t.id,
            scope: { tenantUserId: row.tenant_user_id, outcome: "sign_in_erased" },
          });
        }
      });
      unlinked += 1;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const reason = typeof code === "string" ? code : "unknown";
      deps.logger?.error(
        { event: "member.sign_in_erasure.failed", code: reason },
        "sign-in erasure failed",
      );
      // Audited too (security review L1), so a run that did not finish is visible in the trail.
      await audit(row, {
        outcome: "error",
        reason: "sign_in_not_erased",
        scope: { code: reason },
      }).catch(() => undefined);
    }
  }
  return unlinked;
}
