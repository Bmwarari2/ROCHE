import {
  EndMember,
  MemberEnded,
  MemberLifecycle,
  MemberSuspended,
  SuspendMember,
} from "@harbour/contracts";
import {
  authSession,
  deviceBinding,
  type Transaction,
  task,
  tenantUser,
  withRequestContext,
} from "@harbour/db";
import { createRoute, z } from "@hono/zod-openapi";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { auditInTx, writeAudit } from "../http/audit";
import { requirePermission, type TenantAccess } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { ACCOUNT_DELETION_TASK_KIND } from "../services/account-deletion";
import { entriesToHandOver, hurryRevokedHold, lastReportedWaiting } from "../services/device-holds";
import { inSystemView } from "../services/devices";
import {
  activeElsewhere,
  closeDeletionRequests,
  eraseSignIn,
  signInStateOf,
} from "../services/member-lifecycle";
import { memberReached } from "./member-sessions";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { dbCode, requireStepUp } from "./people-shared";

/**
 * The member lifecycle (H-566; platform.md, Members). A holder of `platform.user.manage`, with
 * step-up and a coded reason, first suspends a membership, then ends it; both reach only members
 * the permission reaches (ADR-0071), anyone else reads as not found. Suspending stops the member's
 * access to this organisation at once (the tenant middleware admits active members only, so Care
 * mode on their phone ends with `not_a_member`), ends every session of their sign-in unless they
 * still work for another organisation (H-354), and makes the holds of entries their devices last
 * reported waiting due at once for a manager to hand over; the manager confirms that count first.
 * Shared devices are not revoked: other staff keep using them. Ending waits until the entries the
 * member owns on a held device are handed over or their deletion is recorded; it ends their roles
 * and grants. The member row, display name and job title stay (Regulation 17). When the member asked
 * for their account to be deleted, the request closes with the outcome: the sign-in is erased once
 * no membership anywhere is invited or active (`eraseSignIn`), else kept for the other
 * organisation and erased by the sweep when that ends.
 */

const PERMISSION = "platform.user.manage";
export const MEMBER_SUSPENDED_ACTION = "platform.member.suspended";
export const MEMBER_ENDED_ACTION = "platform.member.ended";
export const MEMBER_LIFECYCLE_VIEWED_ACTION = "platform.member.lifecycle_viewed";

const REFUSALS = {
  own_membership: () =>
    new HttpProblem(
      409,
      "own_membership",
      "You cannot change your own membership.",
      "Ask another member who manages users to do this.",
    ),
  last_user_manager: () =>
    new HttpProblem(
      409,
      "last_user_manager",
      "This person is the last active member who manages users.",
      "Give another member a role that manages users first, so the organisation keeps one.",
    ),
  membership_state: () =>
    new HttpProblem(
      409,
      "membership_state",
      "This membership cannot change that way.",
      "Suspend an active membership first. Only a suspended membership can be ended.",
    ),
  entries_to_hand_over: (n: number) =>
    new HttpProblem(
      409,
      "entries_to_hand_over",
      "This person's care entries have not all been handed over.",
      `${n} ${n === 1 ? "entry is" : "entries are"} still held on a device. Hand them over or record their deletion on the device, then end the membership.`,
    ),
} as const;

/** The database's refusal of a status change, as the problem the manager can act on. */
function statusRefusal(error: unknown): HttpProblem | null {
  const code = dbCode(error);
  if (code === "HB566") return REFUSALS.own_membership();
  if (code === "23514") return REFUSALS.last_user_manager();
  if (code === "55000") return REFUSALS.membership_state();
  if (code === "P0002") return problems.notFound();
  return null;
}

interface Target {
  readonly authUserId: string | null;
  readonly status: string;
  readonly devices: string[];
}

/** The member, when the manager's permission reaches them, with the devices they are bound to. */
async function targetOf(
  tx: Transaction,
  access: TenantAccess,
  memberId: string,
  now: Date,
): Promise<Target | null> {
  const [member] = await tx
    .select({ authUserId: tenantUser.authUserId, status: tenantUser.status })
    .from(tenantUser)
    .where(and(eq(tenantUser.id, memberId), isNull(tenantUser.deletedAt)));
  if (!member || !(await memberReached(tx, access, memberId, now))) return null;
  const devices = await tx
    .selectDistinct({ id: deviceBinding.deviceId })
    .from(deviceBinding)
    .where(eq(deviceBinding.tenantUserId, memberId));
  return { ...member, devices: devices.map((d) => d.id) };
}

/** Runs the status change as the manager, so the database checks their permission again. */
async function changeStatus(
  access: TenantAccess,
  db: Parameters<typeof withRequestContext>[0],
  memberId: string,
  to: "suspended" | "left",
  then: (tx: Transaction, from: string) => Promise<void>,
): Promise<string> {
  try {
    return await withRequestContext(db, access.context, async (tx) => {
      const result = await tx.execute<{ from: string }>(
        sql`SELECT app.change_member_status(${memberId}::uuid, ${to}) AS "from"`,
      );
      const from = result.rows[0]?.from ?? to;
      await then(tx, from);
      return from;
    });
  } catch (error) {
    const refusal = statusRefusal(error);
    if (refusal) throw refusal;
    throw error;
  }
}

export const memberLifecycleRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/members/{tenantUserId}/lifecycle",
      tags: ["platform"],
      summary: "A member's membership and sign-in status",
      description:
        "The membership's state (invited, active, suspended or ended), when it last changed, whether the member asked for their account to be deleted and whether that request is open, what happened to their sign-in, and the entries their devices last reported waiting and those still to hand over (platform.user.manage, for a member it reaches; anyone else reads as not found, audited by opaque id). No address or sign-in detail.",
      security,
      request: { params: z.object({ tenantUserId: z.uuid() }) },
      responses: {
        200: jsonBody(MemberLifecycle, "The member's status"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { tenantUserId } = c.req.valid("param");
      const services = c.get("services");
      const now = new Date();
      const found = await inSystemView(services.db, access, async (tx) => {
        const [row] = await tx
          .select({
            displayName: tenantUser.displayName,
            jobTitle: tenantUser.jobTitle,
            status: tenantUser.status,
            authUserId: tenantUser.authUserId,
            statusChangedAt: tenantUser.statusChangedAt,
            requestedAt: tenantUser.signInErasureRequestedAt,
            erasedAt: tenantUser.signInErasedAt,
          })
          .from(tenantUser)
          .where(and(eq(tenantUser.id, tenantUserId), isNull(tenantUser.deletedAt)));
        if (!row || !(await memberReached(tx, access, tenantUserId, now))) return null;
        const devices = await tx
          .selectDistinct({ id: deviceBinding.deviceId })
          .from(deviceBinding)
          .where(eq(deviceBinding.tenantUserId, tenantUserId));
        const ids = devices.map((d) => d.id);
        const reports = await lastReportedWaiting(tx, ids);
        const [open] = await tx
          .select({ n: count() })
          .from(task)
          .where(
            and(
              eq(task.kind, ACCOUNT_DELETION_TASK_KIND),
              eq(task.sourceType, "tenant_user"),
              eq(task.sourceId, tenantUserId),
              inArray(task.status, ["open", "in_progress"]),
              isNull(task.deletedAt),
            ),
          );
        return {
          row,
          waiting: [...reports.values()].reduce((sum, r) => sum + r.waiting, 0),
          toHandOver: await entriesToHandOver(tx, tenantUserId, ids),
          requestOpen: (open?.n ?? 0) > 0,
        };
      });
      if (!found) {
        await writeAudit(services.appPool, access, {
          action: MEMBER_LIFECYCLE_VIEWED_ACTION,
          outcome: "denied",
          resourceType: "tenant_user",
          resourceId: tenantUserId,
          reason: "not_found_or_out_of_scope",
          requestId: c.get("requestId"),
        });
        throw problems.notFound();
      }
      const { row } = found;
      const elsewhere = row.authUserId
        ? await activeElsewhere(services.appPool, row.authUserId, access.tenantId)
        : false;
      return c.json(
        {
          id: tenantUserId,
          displayName: row.displayName,
          jobTitle: row.jobTitle,
          state: row.status,
          statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
          deletionRequestedAt: row.requestedAt?.toISOString() ?? null,
          deletionRequestOpen: found.requestOpen,
          signIn: signInStateOf({
            authUserId: row.authUserId,
            signInErasedAt: row.erasedAt,
            elsewhere,
          }),
          signInErasedAt: row.erasedAt?.toISOString() ?? null,
          entriesWaiting: found.waiting,
          entriesToHandOver: found.toHandOver,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/members/{tenantUserId}/suspend",
      tags: ["platform"],
      summary: "Suspend a membership",
      description:
        "Suspends an active membership (platform.user.manage, step-up, a coded reason; audited). The member can no longer reach this organisation, and Care mode on their phone ends. Every session of their sign-in ends too, unless they still work for another organisation, where they keep working. When their devices last reported entries waiting, the suspension needs confirmEntriesWaiting (409 entries_waiting otherwise); those entries stay on the device, protected, and their hold falls due at once for a manager to hand over. Not your own membership (409 own_membership), never the last active member who manages users (409 last_user_manager), only an active one (409 membership_state). A second request changes nothing (replay).",
      security,
      request: {
        params: z.object({ tenantUserId: z.uuid() }),
        body: { content: { "application/json": { schema: SuspendMember } } },
      },
      responses: {
        200: jsonBody(MemberSuspended, "Suspended"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, MEMBER_SUSPENDED_ACTION);
      const { tenantUserId } = c.req.valid("param");
      const { reasonCode, confirmEntriesWaiting } = c.req.valid("json");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const now = new Date();
      const refuse = async (reason: string, problem: HttpProblem, scope = {}) => {
        await writeAudit(services.appPool, access, {
          action: MEMBER_SUSPENDED_ACTION,
          outcome: "denied",
          resourceType: "tenant_user",
          resourceId: tenantUserId,
          reason,
          scope: { reasonCode, ...scope },
          requestId,
        });
        return problem;
      };
      const target = await inSystemView(services.db, access, async (tx) => {
        const found = await targetOf(tx, access, tenantUserId, now);
        if (!found) return null;
        const reports = await lastReportedWaiting(tx, found.devices);
        return { ...found, reports };
      });
      if (!target) throw await refuse("not_found_or_out_of_scope", problems.notFound());
      const waiting = [...target.reports.values()].reduce((sum, r) => sum + r.waiting, 0);
      if (target.status === "active" && waiting > 0 && confirmEntriesWaiting !== true) {
        throw await refuse("entries_waiting", problems.memberEntriesWaiting(waiting), {
          entriesWaiting: waiting,
        });
      }
      const elsewhere = target.authUserId
        ? await activeElsewhere(services.appPool, target.authUserId, access.tenantId)
        : false;
      let from: string;
      try {
        from = await changeStatus(access, services.db, tenantUserId, "suspended", (tx, was) =>
          auditInTx(tx, access, {
            action: MEMBER_SUSPENDED_ACTION,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: { reasonCode, replay: was === "suspended", entriesWaiting: waiting, elsewhere },
            requestId,
          }),
        );
      } catch (error) {
        if (error instanceof HttpProblem) throw await refuse(error.code, error);
        throw error;
      }
      // Sessions belong to the sign-in, not to one organisation (H-354): kept while the person
      // still works elsewhere, where they keep working; this organisation refuses them already.
      let sessionsEnded = 0;
      if (target.authUserId && !elsewhere) {
        const auth = drizzle(services.authPool);
        try {
          sessionsEnded = (
            await auth
              .delete(authSession)
              .where(eq(authSession.userId, target.authUserId))
              .returning({ id: authSession.id })
          ).length;
        } catch (error) {
          await writeAudit(services.appPool, access, {
            action: MEMBER_SUSPENDED_ACTION,
            outcome: "error",
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: "sessions_not_ended",
            requestId,
          });
          throw error;
        }
      }
      // Nobody suspended signs in to send what their phone holds: its hold falls due at once.
      for (const [deviceId, report] of target.reports) {
        await hurryRevokedHold(services.db, access, {
          deviceId,
          waiting: report.waiting,
          now,
          requestId,
          because: "signed_out",
        });
      }
      return c.json(
        {
          state: "suspended" as const,
          replay: from === "suspended",
          sessionsEnded,
          signIn: signInStateOf({
            authUserId: target.authUserId,
            signInErasedAt: null,
            elsewhere,
          }),
          entriesWaiting: waiting,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/members/{tenantUserId}/end",
      tags: ["platform"],
      summary: "End a membership",
      description:
        "Ends a suspended membership (platform.user.manage, step-up, a coded reason; audited): their roles and grants end; the member row, display name and job title stay so care records remain attributable. Refused while entries the member owns are still held on a device (409 entries_to_hand_over), for an active one (409 membership_state) and for your own (409 own_membership). When the member asked for their account to be deleted, the request closes: their sign-in is erased once no membership anywhere is invited or active, else kept for the other organisation and erased when that ends. A second request changes nothing (replay).",
      security,
      request: {
        params: z.object({ tenantUserId: z.uuid() }),
        body: { content: { "application/json": { schema: EndMember } } },
      },
      responses: {
        200: jsonBody(MemberEnded, "Ended"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, MEMBER_ENDED_ACTION);
      const { tenantUserId } = c.req.valid("param");
      const { reasonCode } = c.req.valid("json");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const now = new Date();
      const refuse = async (reason: string, problem: HttpProblem, scope = {}) => {
        await writeAudit(services.appPool, access, {
          action: MEMBER_ENDED_ACTION,
          outcome: "denied",
          resourceType: "tenant_user",
          resourceId: tenantUserId,
          reason,
          scope: { reasonCode, ...scope },
          requestId,
        });
        return problem;
      };
      const target = await inSystemView(services.db, access, async (tx) => {
        const found = await targetOf(tx, access, tenantUserId, now);
        if (!found) return null;
        const [requested] = await tx
          .select({ at: tenantUser.signInErasureRequestedAt })
          .from(tenantUser)
          .where(eq(tenantUser.id, tenantUserId));
        return {
          ...found,
          requested: requested?.at ?? null,
          held: await entriesToHandOver(tx, tenantUserId, found.devices),
        };
      });
      if (!target) throw await refuse("not_found_or_out_of_scope", problems.notFound());
      if (target.status === "suspended" && target.held > 0) {
        throw await refuse("entries_to_hand_over", REFUSALS.entries_to_hand_over(target.held), {
          entriesToHandOver: target.held,
        });
      }
      const elsewhere = target.authUserId
        ? await activeElsewhere(services.appPool, target.authUserId, access.tenantId)
        : false;
      let from: string;
      let closed = 0;
      try {
        from = await changeStatus(access, services.db, tenantUserId, "left", async (tx, was) => {
          await auditInTx(tx, access, {
            action: MEMBER_ENDED_ACTION,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: { reasonCode, replay: was === "left", elsewhere },
            requestId,
          });
          // Kept for the other organisation: this organisation's part of the request is done,
          // and the sweep erases the sign-in once that membership ends too.
          if (target.requested && target.authUserId && elsewhere) {
            closed = await closeDeletionRequests(
              tx,
              access.tenantId,
              tenantUserId,
              "membership_ended_sign_in_kept",
              requestId,
            );
          }
        });
      } catch (error) {
        if (error instanceof HttpProblem) throw await refuse(error.code, error);
        throw error;
      }
      let erased = false;
      if (target.requested && target.authUserId && !elsewhere) {
        erased = await eraseSignIn(
          { appPool: services.appPool, appDb: services.db, authPool: services.authPool },
          target.authUserId,
          requestId,
        );
      }
      const [after] = await inSystemView(services.db, access, (tx) =>
        tx
          .select({ authUserId: tenantUser.authUserId, erasedAt: tenantUser.signInErasedAt })
          .from(tenantUser)
          .where(eq(tenantUser.id, tenantUserId)),
      );
      return c.json(
        {
          state: "left" as const,
          replay: from === "left",
          signIn: signInStateOf({
            authUserId: after?.authUserId ?? null,
            signInErasedAt: after?.erasedAt ?? null,
            elsewhere,
          }),
          deletionRequestClosed: erased || closed > 0,
        },
        200,
      );
    },
  );
