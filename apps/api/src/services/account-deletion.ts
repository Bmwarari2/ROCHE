import type { AccountDeletionRequest } from "@harbour/contracts";
import { notification, task, withRequestContext } from "@harbour/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import type { TenantAccess } from "../http/context";
import { fallbackRecipients } from "./device-holds";
import { rateNumber } from "./rates";

/**
 * A member's request to delete their own account (MOB-011; master prompt 17.3). The stores
 * require an in-app path; a staff account belongs to the care provider (the controller), so the
 * request is routed to the organisation's process rather than acted on: one task for a Registered
 * Manager (else whoever manages members), due within `account_deletion.confirmation_days`, a
 * notification to them, and an audit event. It deletes nothing: the member decides with the
 * provider, and care records are never deleted this way (they follow the retention schedule).
 * A second request while one is open returns the first.
 */

export const ACCOUNT_DELETION_TASK_KIND = "platform.account_deletion_request";
const MANAGE_MEMBERS = "platform.user.manage";
const CONFIRMATION_DAYS_KEY = "account_deletion.confirmation_days";
const DAY_MS = 24 * 3_600_000;

type Db = Parameters<typeof withRequestContext>[0];

export async function requestAccountDeletion(
  db: Db,
  access: TenantAccess,
  requestId: string | undefined,
  now: Date = new Date(),
): Promise<AccountDeletionRequest> {
  // As the system for this organisation, acting for the member: the task is for someone who
  // manages members, which the member usually cannot see (as a device report's task is).
  const system = {
    tenantId: access.tenantId,
    userId: access.tenantUserId,
    scope: "tenant" as const,
    locationIds: [] as string[],
  };
  return withRequestContext(db, system, async (tx) => {
    // One request at a time per member: a double tap or a retry never raises two tasks (security
    // review round 1). No unique index (that needs a migration); the lock is held to commit.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${access.tenantId}:account_deletion:${access.tenantUserId}`}))`,
    );
    const days = await rateNumber(tx, access.tenantId, CONFIRMATION_DAYS_KEY);
    const [open] = await tx
      .select({
        id: task.id,
        createdAt: task.createdAt,
        dueAt: task.dueAt,
        assignee: task.assigneeTenantUserId,
      })
      .from(task)
      .where(
        and(
          eq(task.kind, ACCOUNT_DELETION_TASK_KIND),
          eq(task.sourceType, "tenant_user"),
          eq(task.sourceId, access.tenantUserId),
          inArray(task.status, ["open", "in_progress"]),
          isNull(task.deletedAt),
        ),
      )
      .limit(1);
    if (open) {
      return {
        status: "already_requested",
        requestedAt: open.createdAt.toISOString(),
        respondBy: open.dueAt.toISOString(),
        routedToManager: open.assignee !== null,
      };
    }
    const dueAt = new Date(now.getTime() + days * DAY_MS);
    // A Registered Manager first, else whoever manages members; never the member themselves.
    const recipients = (await fallbackRecipients(tx, MANAGE_MEMBERS, now)).filter(
      (id) => id !== access.tenantUserId,
    );
    const assignee = recipients[0] ?? null;
    const [created] = await tx
      .insert(task)
      .values({
        kind: ACCOUNT_DELETION_TASK_KIND,
        title: "A member asked for their Harbour account to be deleted",
        requiredPermission: MANAGE_MEMBERS,
        sourceType: "tenant_user",
        sourceId: access.tenantUserId,
        assigneeTenantUserId: assignee,
        // Who it is for is the assignee; no role is claimed, since the fallback may not be a
        // Registered Manager (security review round 1).
        assigneeRoleKey: null,
        dueAt,
        priority: "routine",
      })
      .returning({ id: task.id, createdAt: task.createdAt });
    if (!created) throw new Error("The account deletion request was not stored.");
    if (assignee) {
      await tx.insert(notification).values({
        recipientTenantUserId: assignee,
        kind: "platform.account_deletion.requested",
        severity: "info",
        // Opaque: the task names the member to those who may manage members.
        title: "A member asked for their account to be deleted",
        body: `Decide with them and your data protection lead, and confirm within ${days} days. Care records are kept under the retention schedule.`,
        link: "/settings/team",
        channels: ["in_app", "email"],
        sourceType: "task",
        sourceId: created.id,
        dedupeKey: `account_deletion:${created.id}`,
      });
    }
    await auditInTx(tx, access, {
      action: "platform.account_deletion.requested",
      resourceType: "tenant_user",
      resourceId: access.tenantUserId,
      scope: { taskId: created.id, assigneeTenantUserId: assignee, dueAt: dueAt.toISOString() },
      requestId,
    });
    return {
      status: "requested",
      requestedAt: created.createdAt.toISOString(),
      respondBy: dueAt.toISOString(),
      routedToManager: assignee !== null,
    };
  });
}
