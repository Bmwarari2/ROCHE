import { ChangeMembership, EraseSignInResult, MembershipChangeResult } from "@harbour/contracts";
import {
  authSession,
  authUser,
  authVerification,
  deviceBinding,
  operatorUser,
  type Transaction,
  task,
  tenantUser,
} from "@harbour/db";
import {
  checkMembershipChange,
  MEMBERSHIP_MESSAGES,
  type MembershipAction,
  type MembershipProblem,
  type MembershipState,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { AuditedRefusal, auditInTx, withAuditedRefusal, writeAudit } from "../http/audit";
import { membershipsFor, requirePermission, type TenantAccess } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { ACCOUNT_DELETION_TASK_KIND } from "../services/account-deletion";
import { hurryRevokedHold, lastReportedWaiting } from "../services/device-holds";
import { inSystemView } from "../services/devices";
import { memberReached } from "./member-sessions";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { requireStepUp } from "./people-shared";

/**
 * Suspending and ending a membership, and erasing the sign-in (platform.md, Members; recommended
 * answer to H-566, 31/10/2026). Every route needs `platform.user.manage` with step-up and reaches
 * only the members that permission reaches (`memberReached`: a home's manager only staff wholly at
 * their homes); anyone else reads as not found. Suspension ends access to the organisation at once
 * (the tenant middleware admits active memberships only), ends the sign-in's sessions when the
 * person works nowhere else in Harbour, and hurries the holds on their Care mode devices so what
 * they hold is handed over. Ending keeps the member row, display name and job title, so care
 * records stay attributable (Regulation 17). Erasing deletes the sign-in identity (email, password
 * hash, passkeys, TOTP secret, sessions) once the membership has ended and nobody else relies on
 * it, unlinks the member row and closes an open account deletion request. Every change and every
 * refusal is audited by opaque id and code; no address, name or reason in words.
 */

const PERMISSION = "platform.user.manage";
const SUSPENDED = "platform.member.suspended";
const ENDED = "platform.member.ended";
const ERASED = "platform.member.sign_in_erased";
const DELETION_COMPLETED = "platform.account_deletion.completed";
const SIGN_OUT_ACTION = "platform.session.revoked_for_member";

const Params = z.object({ tenantUserId: z.uuid() });

function membershipProblem(problem: MembershipProblem): HttpProblem {
  return new HttpProblem(
    409,
    problem,
    "This membership cannot be changed that way.",
    MEMBERSHIP_MESSAGES[problem],
  );
}

interface LockedMember {
  readonly state: MembershipState;
  readonly authUserId: string | null;
}

/**
 * The member, locked for the change, or null when there is none here or the manager's permission
 * does not reach them (both read as not found).
 */
async function lockMember(
  tx: Transaction,
  access: TenantAccess,
  tenantUserId: string,
  now: Date,
): Promise<LockedMember | null> {
  const [member] = await tx
    .select({ state: tenantUser.status, authUserId: tenantUser.authUserId })
    .from(tenantUser)
    .where(and(eq(tenantUser.id, tenantUserId), isNull(tenantUser.deletedAt)))
    .for("update");
  if (!member || !(await memberReached(tx, access, tenantUserId, now))) return null;
  return member;
}

/** Active memberships of the sign-in in other organisations (never names them). */
async function elsewhere(
  appPool: pg.Pool,
  access: TenantAccess,
  authUserId: string | null,
): Promise<number> {
  if (!authUserId) return 0;
  return (await membershipsFor(appPool, authUserId)).filter((m) => m.tenantId !== access.tenantId)
    .length;
}

/**
 * Whether the sign-in is a Harbour operator's: the same identity-level lookup by opaque id the
 * operator middleware makes (`routes/operator.ts`), returning only yes or no.
 */
async function isOperator(operatorPool: pg.Pool, authUserId: string | null): Promise<boolean> {
  if (!authUserId) return false;
  const [op] = await drizzle(operatorPool)
    .select({ id: operatorUser.id })
    .from(operatorUser)
    .where(eq(operatorUser.authUserId, authUserId))
    .limit(1);
  return op !== undefined;
}

const refusal = (
  action: string,
  tenantUserId: string,
  reason: string,
  problem: HttpProblem,
  scope: Record<string, unknown> = {},
) =>
  new AuditedRefusal(problem, {
    action,
    outcome: "denied",
    resourceType: "tenant_user",
    resourceId: tenantUserId,
    reason,
    scope,
  });

function checked(
  action: MembershipAction,
  auditAction: string,
  tenantUserId: string,
  access: TenantAccess,
  member: LockedMember,
  facts: { readonly otherActiveMemberships?: number; readonly operator?: boolean } = {},
  scope: Record<string, unknown> = {},
): "apply" | "replay" {
  const check = checkMembershipChange({
    action,
    state: member.state,
    self: tenantUserId === access.tenantUserId,
    signInLinked: member.authUserId !== null,
    otherActiveMemberships: facts.otherActiveMemberships ?? 0,
    operator: facts.operator ?? false,
  });
  if (!check.ok) {
    throw refusal(
      auditAction,
      tenantUserId,
      check.problem,
      membershipProblem(check.problem),
      scope,
    );
  }
  return check.outcome;
}

export const memberLifecycleRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/members/{tenantUserId}/suspend",
      tags: ["platform"],
      summary: "Suspend a member of staff",
      description:
        "platform.user.manage with step-up and a coded reason (H-566). The membership becomes suspended: the member can no longer use this organisation, and their open invitations end. When their Care mode devices last reported entries waiting, it needs confirmEntriesWaiting (409 entries_waiting otherwise); the holds on those devices then fall due at once so the entries are handed over. Every session of the member's sign-in ends unless they also work for another organisation in Harbour or the sign-in is a Harbour operator's (sessionsEnded 0: this organisation refuses them anyway). A suspended member suspended again changes nothing (replay). A location role reaches only members wholly at its homes; anyone else reads as not found. Never the manager's own membership (409 own_membership), nor one that has ended (409 membership_ended). Audited (platform.member.suspended, with the reason code), refusals too.",
      security,
      request: {
        params: Params,
        body: { content: { "application/json": { schema: ChangeMembership } } },
      },
      responses: {
        200: jsonBody(MembershipChangeResult, "Suspended (or already suspended)"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, SUSPENDED);
      const { tenantUserId } = c.req.valid("param");
      const { reasonCode, confirmEntriesWaiting } = c.req.valid("json");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const now = new Date();
      const done = await withAuditedRefusal(c, access, () =>
        inSystemView(services.db, access, async (tx) => {
          const member = await lockMember(tx, access, tenantUserId, now);
          if (!member) {
            throw refusal(
              SUSPENDED,
              tenantUserId,
              "not_found_or_out_of_scope",
              problems.notFound(),
              {
                reasonCode,
              },
            );
          }
          const outcome = checked(
            "suspend",
            SUSPENDED,
            tenantUserId,
            access,
            member,
            {},
            { reasonCode },
          );
          if (outcome === "replay") {
            return { replay: true, signOut: null, reports: new Map(), waiting: 0 };
          }
          const devices = await tx
            .selectDistinct({ id: deviceBinding.deviceId })
            .from(deviceBinding)
            .where(
              and(eq(deviceBinding.tenantUserId, tenantUserId), isNull(deviceBinding.revokedAt)),
            );
          const reports = await lastReportedWaiting(
            tx,
            devices.map((d) => d.id),
          );
          const waiting = [...reports.values()].reduce((sum, r) => sum + r.waiting, 0);
          if (waiting > 0 && confirmEntriesWaiting !== true) {
            throw refusal(
              SUSPENDED,
              tenantUserId,
              "entries_waiting",
              problems.memberEntriesWaiting(waiting),
              { reasonCode, entriesWaiting: waiting },
            );
          }
          // Sessions belong to the person's sign-in: ended only when they work nowhere else in
          // Harbour and the sign-in is not also a Harbour operator's.
          const signOut =
            member.authUserId !== null &&
            (await elsewhere(services.appPool, access, member.authUserId)) === 0 &&
            !(await isOperator(services.operatorPool, member.authUserId))
              ? member.authUserId
              : null;
          await tx
            .update(tenantUser)
            .set({ status: "suspended" })
            .where(eq(tenantUser.id, tenantUserId));
          // Audited before the sessions end: they live under another database role (#40 review).
          await auditInTx(tx, access, {
            action: SUSPENDED,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: {
              reasonCode,
              from: member.state,
              entriesWaiting: waiting,
              endsSessions: signOut !== null,
            },
            requestId,
          });
          return { replay: false, signOut, reports, waiting };
        }),
      );
      let sessionsEnded = 0;
      if (done.signOut) {
        try {
          sessionsEnded = (
            await drizzle(services.authPool)
              .delete(authSession)
              .where(eq(authSession.userId, done.signOut))
              .returning({ id: authSession.id })
          ).length;
        } catch (error) {
          await writeAudit(services.appPool, access, {
            action: SIGN_OUT_ACTION,
            outcome: "error",
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: "sessions_not_ended",
            scope: { reasonCode: "suspended" },
            requestId,
          });
          throw error;
        }
      }
      // A suspended member will not sign in to send what their phone holds: the hold falls due at
      // once, as after a revocation, so another member hands it over (#40 review M2).
      for (const [deviceId, report] of done.reports) {
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
          tenantUserId,
          state: "suspended" as const,
          replay: done.replay,
          sessionsEnded,
          entriesWaiting: done.waiting,
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
      summary: "End a suspended member's membership",
      description:
        "platform.user.manage with step-up and a coded reason (H-566). Only a suspended membership ends (409 suspend_first otherwise), so access and devices are dealt with first. The member row, display name and job title stay, so care records stay attributable (Regulation 17); the staff file follows its retention class. An ended membership ended again changes nothing (replay). Erase the sign-in next with POST /v1/members/{tenantUserId}/sign-in/erase. Same reach and refusals as suspending. Audited (platform.member.ended), refusals too.",
      security,
      request: {
        params: Params,
        body: { content: { "application/json": { schema: ChangeMembership } } },
      },
      responses: {
        200: jsonBody(MembershipChangeResult, "Ended (or already ended)"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, ENDED);
      const { tenantUserId } = c.req.valid("param");
      const { reasonCode } = c.req.valid("json");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const now = new Date();
      const replay = await withAuditedRefusal(c, access, () =>
        inSystemView(services.db, access, async (tx) => {
          const member = await lockMember(tx, access, tenantUserId, now);
          if (!member) {
            throw refusal(ENDED, tenantUserId, "not_found_or_out_of_scope", problems.notFound(), {
              reasonCode,
            });
          }
          if (
            checked("end", ENDED, tenantUserId, access, member, {}, { reasonCode }) === "replay"
          ) {
            return true;
          }
          await tx
            .update(tenantUser)
            .set({ status: "left" })
            .where(eq(tenantUser.id, tenantUserId));
          await auditInTx(tx, access, {
            action: ENDED,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: { reasonCode, from: member.state },
            requestId,
          });
          return false;
        }),
      );
      return c.json(
        { tenantUserId, state: "left" as const, replay, sessionsEnded: 0, entriesWaiting: 0 },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/members/{tenantUserId}/sign-in/erase",
      tags: ["platform"],
      summary: "Erase an ended member's sign-in",
      description:
        "platform.user.manage with step-up (H-566). Only for an ended membership (409 membership_not_ended otherwise), and only when the sign-in has no active membership in any other organisation and is not a Harbour operator's (409 sign_in_in_use: kept, since it is theirs to use elsewhere). Deletes the sign-in identity: the email address, password hash, passkeys, TOTP secret and every session. The member row stays, unlinked, with its display name and job title, so care records stay attributable. An open account deletion request for the member closes as done. Audited before the identity goes (platform.member.sign_in_erased; the request's closure platform.account_deletion.completed), by opaque id only. A sign-in already erased changes nothing (erased false). Same reach and refusals as suspending.",
      security,
      request: { params: Params },
      responses: {
        200: jsonBody(EraseSignInResult, "Erased (or already erased)"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, ERASED);
      const { tenantUserId } = c.req.valid("param");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const now = new Date();
      const plan = await withAuditedRefusal(c, access, () =>
        inSystemView(services.db, access, async (tx) => {
          const member = await lockMember(tx, access, tenantUserId, now);
          if (!member) {
            throw refusal(ERASED, tenantUserId, "not_found_or_out_of_scope", problems.notFound());
          }
          const outcome = checked("erase_sign_in", ERASED, tenantUserId, access, member, {
            otherActiveMemberships: await elsewhere(services.appPool, access, member.authUserId),
            operator: await isOperator(services.operatorPool, member.authUserId),
          });
          return outcome === "replay" ? null : member.authUserId;
        }),
      );
      if (plan === null) {
        return c.json({ tenantUserId, erased: false, deletionRequestClosed: false }, 200);
      }
      // Audited before the identity goes: the audit trail and the sign-in live under different
      // database roles, so one transaction cannot hold both (#40 review).
      await writeAudit(services.appPool, access, {
        action: ERASED,
        resourceType: "tenant_user",
        resourceId: tenantUserId,
        scope: { erased: ["email", "password", "passkeys", "totp", "sessions"] },
        requestId,
      });
      try {
        await eraseSignIn(services.authPool, plan);
      } catch (error) {
        await writeAudit(services.appPool, access, {
          action: ERASED,
          outcome: "error",
          resourceType: "tenant_user",
          resourceId: tenantUserId,
          reason: "sign_in_not_erased",
          requestId,
        });
        throw error;
      }
      const deletionRequestClosed = await inSystemView(services.db, access, async (tx) => {
        // Unlinked only from the sign-in just erased, so a retry after a failure here finishes.
        await tx
          .update(tenantUser)
          .set({ authUserId: null })
          .where(and(eq(tenantUser.id, tenantUserId), eq(tenantUser.authUserId, plan)));
        const closed = await tx
          .update(task)
          .set({
            status: "done",
            statusReason: "sign_in_erased",
            completedAt: now,
            completedBy: access.tenantUserId,
          })
          .where(
            and(
              eq(task.kind, ACCOUNT_DELETION_TASK_KIND),
              eq(task.sourceType, "tenant_user"),
              eq(task.sourceId, tenantUserId),
              inArray(task.status, ["open", "in_progress"]),
              isNull(task.deletedAt),
            ),
          )
          .returning({ id: task.id });
        for (const t of closed) {
          await auditInTx(tx, access, {
            action: DELETION_COMPLETED,
            resourceType: "task",
            resourceId: t.id,
            scope: { tenantUserId, outcome: "sign_in_erased" },
            requestId,
          });
        }
        return closed.length > 0;
      });
      return c.json({ tenantUserId, erased: true, deletionRequestClosed }, 200);
    },
  );

/**
 * Deletes a sign-in identity in one transaction of the auth role: its verification tokens (by
 * address, by user, and the second-factor records of its sessions), then the user, whose sessions,
 * accounts (password hash), TOTP secret and backup codes, and passkeys go with it (foreign keys on
 * delete cascade). A sign-in already gone deletes nothing.
 */
async function eraseSignIn(authPool: pg.Pool, authUserId: string): Promise<void> {
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
      await auth
        .delete(authVerification)
        .where(
          or(
            eq(authVerification.identifier, user.email),
            eq(authVerification.value, authUserId),
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
