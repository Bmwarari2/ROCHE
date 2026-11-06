import {
  EndMember,
  MemberEnded,
  MemberLifecycle,
  MemberReinstated,
  MemberSuspended,
  ReinstateMember,
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
import {
  entriesToHandOver,
  hurryRevokedHold,
  lastReportedWaiting,
  waitingOwnedBy,
} from "../services/device-holds";
import { inSystemView } from "../services/devices";
import {
  closeDeletionRequests,
  eraseSignIn,
  membershipElsewhere,
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
export const MEMBER_REINSTATED_ACTION = "platform.member.reinstated";
export const MEMBER_LIFECYCLE_VIEWED_ACTION = "platform.member.lifecycle_viewed";

const REFUSALS = {
  own_membership: () =>
    new HttpProblem(
      409,
      "own_membership",
      "You cannot change your own membership.",
      "Ask another member who manages users to do this.",
    ),
  beyond_inviter: () =>
    new HttpProblem(
      403,
      "beyond_inviter",
      "You cannot give this person's roles back.",
      "Their roles include permissions you do not hold where they apply. Ask someone who holds them.",
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
      "Suspend an active membership first. Only a suspended membership can be reinstated or ended.",
    ),
  devices_unchecked: (n: number) =>
    new HttpProblem(
      409,
      "devices_unchecked",
      "Check the devices this person used before you end the membership.",
      `They used ${n} ${n === 1 ? "device" : "devices"} for Care mode. A suspended member's phone cannot report again, so entries written since its last report are known only to whoever holds it. Say how you checked: the device was returned and checked, or it is lost and an incident was raised.`,
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
  if (code === "HB567") return REFUSALS.beyond_inviter();
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
  return { ...member, devices: await devicesOf(tx, memberId) };
}

/** Runs the status change as the manager, so the database checks their permission again. */
async function changeStatus(
  access: TenantAccess,
  db: Parameters<typeof withRequestContext>[0],
  memberId: string,
  to: "suspended" | "active" | "left",
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

/** The devices the member is bound to (any binding, revoked or not). */
async function devicesOf(tx: Transaction, memberId: string): Promise<string[]> {
  const devices = await tx
    .selectDistinct({ id: deviceBinding.deviceId })
    .from(deviceBinding)
    .where(eq(deviceBinding.tenantUserId, memberId));
  return devices.map((d) => d.id);
}

/** Audits a refusal by opaque id, then gives back the problem to throw. */
function refusalFor(
  pool: Parameters<typeof writeAudit>[0],
  access: TenantAccess,
  action: string,
  memberId: string,
  context: { readonly reasonCode: string; readonly requestId: string | undefined },
) {
  return async (reason: string, problem: HttpProblem, scope = {}) => {
    await writeAudit(pool, access, {
      action,
      outcome: "denied",
      resourceType: "tenant_user",
      resourceId: memberId,
      reason,
      scope: { reasonCode: context.reasonCode, ...scope },
      requestId: context.requestId,
    });
    return problem;
  };
}

export const memberLifecycleRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/members/{tenantUserId}/lifecycle",
      tags: ["platform"],
      summary: "A member's membership and sign-in status",
      description:
        "The membership's state (invited, active, suspended or ended), when it last changed, whether the member asked for their account to be deleted and whether that request is open, what happened to their sign-in, the entries their devices last reported waiting as theirs and those still to hand over, how many devices they used and when one last reported (platform.user.manage, for a member it reaches; anyone else reads as not found, audited by opaque id). No address or sign-in detail.",
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
        const ids = await devicesOf(tx, tenantUserId);
        const reports = await lastReportedWaiting(tx, ids);
        const owned = await waitingOwnedBy(tx, tenantUserId, ids);
        const latest = [...reports.values()]
          .map((r) => r.at)
          .sort((x, y) => y.getTime() - x.getTime())[0];
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
          devices: ids.length,
          latest: latest ?? null,
          waiting: [...owned.values()].reduce((sum, n) => sum + n, 0),
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
        ? await membershipElsewhere(services.appPool, row.authUserId, access.tenantId)
        : "none";
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
            elsewhere: elsewhere !== "none",
          }),
          signInErasedAt: row.erasedAt?.toISOString() ?? null,
          entriesWaiting: found.waiting,
          entriesToHandOver: found.toHandOver,
          devicesUsed: found.devices,
          lastReportedAt: found.latest?.toISOString() ?? null,
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
        "Suspends an active membership (platform.user.manage, step-up, a coded reason; audited). The member can no longer reach this organisation, and Care mode on their phone ends. Every session of their sign-in ends too, unless they still work for another organisation, where they keep working. When their devices last reported entries of theirs waiting, the suspension needs confirmEntriesWaiting (409 entries_waiting otherwise); those entries stay on the device, protected, and their hold falls due at once for a manager to hand over. Not your own membership (409 own_membership), never the last active member who manages users (409 last_user_manager), only an active one (409 membership_state). A second request changes nothing (replay).",
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
      const refuse = refusalFor(services.appPool, access, MEMBER_SUSPENDED_ACTION, tenantUserId, {
        reasonCode,
        requestId,
      });
      const target = await inSystemView(services.db, access, async (tx) => {
        const found = await targetOf(tx, access, tenantUserId, now);
        if (!found) return null;
        return { ...found, owned: await waitingOwnedBy(tx, tenantUserId, found.devices) };
      });
      if (!target) throw await refuse("not_found_or_out_of_scope", problems.notFound());
      const waiting = [...target.owned.values()].reduce((sum, n) => sum + n, 0);
      if (target.status === "active" && waiting > 0 && confirmEntriesWaiting !== true) {
        throw await refuse("entries_waiting", problems.memberEntriesWaiting(waiting), {
          entriesWaiting: waiting,
        });
      }
      const elsewhere = target.authUserId
        ? await membershipElsewhere(services.appPool, target.authUserId, access.tenantId)
        : "none";
      let from: string;
      try {
        from = await changeStatus(access, services.db, tenantUserId, "suspended", (tx, was) =>
          auditInTx(tx, access, {
            action: MEMBER_SUSPENDED_ACTION,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: {
              reasonCode,
              replay: was === "suspended",
              entriesWaiting: waiting,
              elsewhere: elsewhere === "active",
            },
            requestId,
          }),
        );
      } catch (error) {
        if (error instanceof HttpProblem) throw await refuse(error.code, error);
        throw error;
      }
      // Nobody suspended signs in to send what their phone holds: its hold falls due at once,
      // before the sessions end, so a failure there never leaves it unhurried (clinical review L3).
      for (const [deviceId, owned] of target.owned) {
        await hurryRevokedHold(services.db, access, {
          deviceId,
          waiting: owned,
          now,
          requestId,
          because: "signed_out",
        });
      }
      // Sessions belong to the sign-in, not to one organisation (H-354): kept while the person
      // still works elsewhere, where they keep working; this organisation refuses them already.
      let sessionsEnded = 0;
      if (target.authUserId && elsewhere !== "active") {
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
      return c.json(
        {
          state: "suspended" as const,
          replay: from === "suspended",
          sessionsEnded,
          signIn: signInStateOf({
            authUserId: target.authUserId,
            signInErasedAt: null,
            elsewhere: elsewhere === "active",
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
      path: "/v1/members/{tenantUserId}/reinstate",
      tags: ["platform"],
      summary: "Reinstate a suspended membership",
      description:
        "Undoes a suspension before the membership is ended (H-1392; platform.user.manage, step-up, a coded reason; audited): the membership is active again with the roles and grants it had. Sessions ended at the suspension stay ended, so the member signs in again; held entries stay held until handed over or sent. Only a suspended membership whose sign-in erasure has not begun (409 membership_state), never your own (409 own_membership), and only when you hold every permission of their roles and grants where they apply (403 beyond_inviter, as for an invitation). An active one changes nothing (replay).",
      security,
      request: {
        params: z.object({ tenantUserId: z.uuid() }),
        body: { content: { "application/json": { schema: ReinstateMember } } },
      },
      responses: {
        200: jsonBody(MemberReinstated, "Reinstated"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, MEMBER_REINSTATED_ACTION);
      const { tenantUserId } = c.req.valid("param");
      const { reasonCode } = c.req.valid("json");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const now = new Date();
      const refuse = refusalFor(services.appPool, access, MEMBER_REINSTATED_ACTION, tenantUserId, {
        reasonCode,
        requestId,
      });
      const target = await inSystemView(services.db, access, (tx) =>
        targetOf(tx, access, tenantUserId, now),
      );
      if (!target) throw await refuse("not_found_or_out_of_scope", problems.notFound());
      let from: string;
      try {
        from = await changeStatus(access, services.db, tenantUserId, "active", (tx, was) =>
          auditInTx(tx, access, {
            action: MEMBER_REINSTATED_ACTION,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: { reasonCode, replay: was === "active" },
            requestId,
          }),
        );
      } catch (error) {
        if (error instanceof HttpProblem) throw await refuse(error.code, error);
        throw error;
      }
      return c.json({ state: "active" as const, replay: from === "active" }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/members/{tenantUserId}/end",
      tags: ["platform"],
      summary: "End a membership",
      description:
        "Ends a suspended membership (platform.user.manage, step-up, a coded reason; audited): their roles and grants end; the member row, display name and job title stay so care records remain attributable. Refused while entries the member owns are still held on a device (409 entries_to_hand_over), when they used any device for Care mode and deviceCheck does not say how its contents were checked (409 devices_unchecked), for an active one (409 membership_state) and for your own (409 own_membership). When the member asked for their account to be deleted, the request closes: their sign-in is erased once no membership anywhere is invited, active or suspended, else kept for the other organisation and erased when that ends. A second request changes nothing (replay).",
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
      const { reasonCode, deviceCheck } = c.req.valid("json");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const now = new Date();
      const refuse = refusalFor(services.appPool, access, MEMBER_ENDED_ACTION, tenantUserId, {
        reasonCode,
        requestId,
      });
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
      if (target.status === "suspended" && target.devices.length > 0 && !deviceCheck) {
        throw await refuse("devices_unchecked", REFUSALS.devices_unchecked(target.devices.length), {
          devicesUsed: target.devices.length,
        });
      }
      const elsewhere = target.authUserId
        ? await membershipElsewhere(services.appPool, target.authUserId, access.tenantId)
        : "none";
      let from: string;
      let closed = 0;
      try {
        from = await changeStatus(access, services.db, tenantUserId, "left", async (tx, was) => {
          await auditInTx(tx, access, {
            action: MEMBER_ENDED_ACTION,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: {
              reasonCode,
              deviceCheck: deviceCheck ?? null,
              devicesUsed: target.devices.length,
              replay: was === "left",
              elsewhere: elsewhere !== "none",
            },
            requestId,
          });
          // Kept for the other organisation: this organisation's part of the request is done,
          // and the sweep erases the sign-in once that membership ends too.
          if (target.requested && target.authUserId && elsewhere !== "none") {
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
      if (target.requested && target.authUserId && elsewhere === "none") {
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
            elsewhere: elsewhere !== "none",
          }),
          deletionRequestClosed: erased || closed > 0,
        },
        200,
      );
    },
  );
