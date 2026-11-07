import {
  ChangeMembership,
  EraseSignInResult,
  MemberLifecycle,
  MembershipChangeResult,
  ReinstateMember,
} from "@harbour/contracts";
import {
  authSession,
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
  scopeFor,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { AuditedRefusal, auditInTx, withAuditedRefusal, writeAudit } from "../http/audit";
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
import { ERASED_SCOPE, eraseSignInIdentity } from "../services/member-erasure";
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
 * person has no other membership in Harbour that has not ended, and hurries the holds on their
 * Care mode devices so what they hold is handed over. Ending keeps the member row, display name
 * and job title, so care records stay attributable (Regulation 17). Erasing deletes the sign-in
 * identity (its email address, password hash, passkeys, TOTP secret, sessions and verification
 * tokens) once the membership has ended and nobody else relies on it, unlinks the member row and
 * closes an open account deletion request. The database makes every change to the member row
 * (`app.change_membership`, migration 0129: the application role cannot change a member's status
 * or sign-in link itself) and keeps the organisation's last member who manages users through a
 * role. Every change and every refusal is audited by opaque id and code; no address, name or
 * reason in words.
 */

const PERMISSION = "platform.user.manage";
const SUSPENDED = "platform.member.suspended";
const ENDED = "platform.member.ended";
const ERASED = "platform.member.sign_in_erased";
const REINSTATED = "platform.member.reinstated";
const LIFECYCLE_VIEWED = "platform.member.lifecycle_viewed";
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
  readonly signInErasedAt: Date | null;
  readonly deletionRequestedAt: Date | null;
}

/**
 * The member, read under the organisation's membership-change lock, or null when there is none
 * here or the manager's permission does not reach them (both read as not found). The lock is the
 * one `app.change_membership` takes before it locks the manager's and the member's rows in id
 * order, so membership changes in an organisation run one at a time and never deadlock.
 */
async function lockMember(
  tx: Transaction,
  access: TenantAccess,
  tenantUserId: string,
  now: Date,
): Promise<LockedMember | null> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`${access.tenantId}:membership_change`}))`,
  );
  const [member] = await tx
    .select({
      state: tenantUser.status,
      authUserId: tenantUser.authUserId,
      signInErasedAt: tenantUser.signInErasedAt,
      deletionRequestedAt: tenantUser.signInErasureRequestedAt,
    })
    .from(tenantUser)
    .where(and(eq(tenantUser.id, tenantUserId), isNull(tenantUser.deletedAt)));
  if (!member || !(await memberReached(tx, access, tenantUserId, now))) return null;
  return member;
}

/**
 * Memberships of the member's sign-in in other organisations that have not ended (invited, active
 * or suspended): a count only, from the database (`app.sign_in_memberships_elsewhere`).
 */
async function elsewhere(tx: Transaction, tenantUserId: string): Promise<number> {
  const result = await tx.execute<{ n: number }>(
    sql`SELECT app.sign_in_memberships_elsewhere(${tenantUserId}::uuid) AS n`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** The devices the member is bound to for Care mode (any binding, revoked or not). */
async function devicesOf(tx: Transaction, tenantUserId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: deviceBinding.deviceId })
    .from(deviceBinding)
    .where(eq(deviceBinding.tenantUserId, tenantUserId));
  return rows.map((r) => r.id);
}

/** Whether the manager holds platform.user.manage across the organisation (ADR-0071). */
function organisationWide(access: TenantAccess): boolean {
  return scopeFor(access.effective, PERMISSION).scope === "tenant";
}

const DATABASE_REFUSALS: ReadonlySet<string> = new Set<MembershipProblem>([
  "beyond_inviter",
  "leaving_still_recorded",
  "own_membership",
  "membership_ended",
  "suspend_first",
  "membership_not_ended",
  "last_user_manager",
]);

/**
 * Makes the change in the database (`app.change_membership`), which checks the permission, the
 * transition and the organisation's last user manager again; its refusal reads as the domain's.
 */
async function changeInDatabase(
  tx: Transaction,
  tenantUserId: string,
  action: "suspend" | "reinstate" | "end" | "unlink_sign_in",
  auditAction: string,
  scope: Record<string, unknown> = {},
): Promise<void> {
  try {
    await tx.execute(sql`SELECT app.change_membership(${tenantUserId}::uuid, ${action})`);
  } catch (error) {
    const message =
      (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
    if (DATABASE_REFUSALS.has(message)) {
      const problem = message as MembershipProblem;
      throw refusal(auditAction, tenantUserId, problem, membershipProblem(problem), scope);
    }
    throw error;
  }
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
  facts: {
    readonly otherMemberships?: number;
    readonly operator?: boolean;
    readonly organisationWide?: boolean;
  } = {},
  scope: Record<string, unknown> = {},
): "apply" | "replay" {
  const check = checkMembershipChange({
    action,
    state: member.state,
    self: tenantUserId === access.tenantUserId,
    signInLinked: member.authUserId !== null,
    otherMemberships: facts.otherMemberships ?? 0,
    operator: facts.operator ?? false,
    organisationWide: facts.organisationWide ?? false,
    signInErased: member.signInErasedAt !== null,
    deletionRequested: member.deletionRequestedAt !== null,
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
        "platform.user.manage with step-up and a coded reason (H-566). The membership becomes suspended: the member can no longer use this organisation, and their open invitations end. When their Care mode devices last reported entries waiting, it needs confirmEntriesWaiting (409 entries_waiting otherwise); the holds on those devices then fall due at once so the entries are handed over. Every session of the member's sign-in ends unless they have a membership with another organisation in Harbour that has not ended, or the sign-in is a Harbour operator's (sessionsEnded 0: this organisation refuses them anyway). The organisation's last active member who manages users through a role is never suspended (409 last_user_manager). The database makes the change (app.change_membership, migration 0129). A suspended member suspended again changes nothing (replay). A location role reaches only members wholly at its homes; anyone else reads as not found. Never the manager's own membership (409 own_membership), nor one that has ended (409 membership_ended). Audited (platform.member.suspended, with the reason code), refusals too.",
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
            return { replay: true, signOut: null, reports: new Map<string, number>(), waiting: 0 };
          }
          // Only the member's own entries: a colleague's on a shared device are neither counted
          // nor hurried (H-566 clinical review M1).
          const reports = await waitingOwnedBy(tx, tenantUserId, await devicesOf(tx, tenantUserId));
          const waiting = [...reports.values()].reduce((sum, n) => sum + n, 0);
          if (waiting > 0 && confirmEntriesWaiting !== true) {
            throw refusal(
              SUSPENDED,
              tenantUserId,
              "entries_waiting",
              problems.memberEntriesWaiting(waiting),
              { reasonCode, entriesWaiting: waiting },
            );
          }
          // Sessions belong to the person's sign-in: ended only when they have no other
          // membership in Harbour that has not ended and the sign-in is not a Harbour operator's.
          const signOut =
            member.authUserId !== null &&
            (await elsewhere(tx, tenantUserId)) === 0 &&
            !(await isOperator(services.operatorPool, member.authUserId))
              ? member.authUserId
              : null;
          await changeInDatabase(tx, tenantUserId, "suspend", SUSPENDED, {
            reasonCode,
            entriesWaiting: waiting,
          });
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
      for (const [deviceId, owned] of done.reports) {
        await hurryRevokedHold(services.db, access, {
          deviceId,
          waiting: owned,
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
      const { reasonCode, deviceCheck } = c.req.valid("json");
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
          // What the member's devices still hold (H-566 clinical review B1, M2, M4): entries of
          // theirs held on a device with an open hold wait to be handed over; and a suspended
          // phone cannot report again, so the manager says how each device was checked.
          const devices = await devicesOf(tx, tenantUserId);
          const held = await entriesToHandOver(tx, tenantUserId, devices);
          if (held > 0) {
            throw refusal(
              ENDED,
              tenantUserId,
              "entries_to_hand_over",
              membershipProblem("entries_to_hand_over"),
              { reasonCode, entriesToHandOver: held },
            );
          }
          if (devices.length > 0 && !deviceCheck) {
            throw refusal(
              ENDED,
              tenantUserId,
              "devices_unchecked",
              membershipProblem("devices_unchecked"),
              { reasonCode, devicesUsed: devices.length },
            );
          }
          await changeInDatabase(tx, tenantUserId, "end", ENDED, { reasonCode });
          await auditInTx(tx, access, {
            action: ENDED,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: {
              reasonCode,
              from: member.state,
              deviceCheck: deviceCheck ?? null,
              devicesUsed: devices.length,
            },
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
      path: "/v1/members/{tenantUserId}/reinstate",
      tags: ["platform"],
      summary: "Reinstate a suspended member",
      description:
        "platform.user.manage with step-up and a coded reason (H-566, H-1463, H-1469). Undoes a suspension, or, for a holder of the permission across the organisation, an ending whose sign-in has not been erased (a wrong leaving date withdrawn; the roles and grants ended with it stay ended): the member is active again (invited when they never made a sign-in), with the roles and grants they had, and only when the manager holds every permission of those roles and grants where they apply (403 beyond_inviter, the invitation rule). Sessions ended at the suspension stay ended, so the member signs in again; held entries stay on their devices until the member sends them or a manager hands them over. Otherwise an ended membership is not reinstated (409 membership_ended); an active one changes nothing (replay). Same reach and refusals as suspending. Audited (platform.member.reinstated), refusals too.",
      security,
      request: {
        params: Params,
        body: { content: { "application/json": { schema: ReinstateMember } } },
      },
      responses: {
        200: jsonBody(MembershipChangeResult, "Reinstated (or already active)"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, REINSTATED);
      const { tenantUserId } = c.req.valid("param");
      const { reasonCode } = c.req.valid("json");
      const services = c.get("services");
      const requestId = c.get("requestId");
      const now = new Date();
      const done = await withAuditedRefusal(c, access, () =>
        inSystemView(services.db, access, async (tx) => {
          const member = await lockMember(tx, access, tenantUserId, now);
          if (!member) {
            throw refusal(
              REINSTATED,
              tenantUserId,
              "not_found_or_out_of_scope",
              problems.notFound(),
              {
                reasonCode,
              },
            );
          }
          if (
            checked(
              "reinstate",
              REINSTATED,
              tenantUserId,
              access,
              member,
              { organisationWide: organisationWide(access) },
              { reasonCode },
            ) === "replay"
          ) {
            return { replay: true, state: member.state };
          }
          // Whether the manager holds everything the member's roles and grants give, where they
          // apply (app.may_invite, as for an invitation), read under the lock (security review L2).
          const may = await tx.execute<{ may: boolean }>(
            sql`SELECT app.may_invite(${tenantUserId}::uuid) AS may`,
          );
          if (may.rows[0]?.may !== true) {
            throw refusal(
              REINSTATED,
              tenantUserId,
              "beyond_inviter",
              new HttpProblem(
                403,
                "beyond_inviter",
                "You cannot give this person's roles back.",
                MEMBERSHIP_MESSAGES.beyond_inviter,
              ),
              { reasonCode },
            );
          }
          await changeInDatabase(tx, tenantUserId, "reinstate", REINSTATED, { reasonCode });
          const state = member.authUserId === null ? ("invited" as const) : ("active" as const);
          await auditInTx(tx, access, {
            action: REINSTATED,
            resourceType: "tenant_user",
            resourceId: tenantUserId,
            reason: reasonCode,
            scope: { reasonCode, from: member.state, to: state },
            requestId,
          });
          return { replay: false, state };
        }),
      );
      return c.json(
        {
          tenantUserId,
          state: done.state,
          replay: done.replay,
          sessionsEnded: 0,
          entriesWaiting: 0,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/members/{tenantUserId}/lifecycle",
      tags: ["platform"],
      summary: "A member's membership and sign-in status",
      description:
        "platform.user.manage, for a member it reaches (anyone else reads as not found, audited by opaque id). The membership's state, when it last changed, whether the member asked for their account to be deleted and whether that request is open, what happened to their sign-in, the entries their devices last reported waiting as theirs and those still to hand over, how many devices they used and when one last reported. No address or sign-in detail.",
      security,
      request: { params: Params },
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
            state: tenantUser.status,
            authUserId: tenantUser.authUserId,
            statusChangedAt: tenantUser.statusChangedAt,
            requestedAt: tenantUser.signInErasureRequestedAt,
            erasedAt: tenantUser.signInErasedAt,
          })
          .from(tenantUser)
          .where(and(eq(tenantUser.id, tenantUserId), isNull(tenantUser.deletedAt)));
        if (!row || !(await memberReached(tx, access, tenantUserId, now))) return null;
        const devices = await devicesOf(tx, tenantUserId);
        const reports = await lastReportedWaiting(tx, devices);
        const owned = await waitingOwnedBy(tx, tenantUserId, devices);
        const latest = [...reports.values()]
          .map((r) => r.at)
          .sort((x, y) => y.getTime() - x.getTime())[0];
        const open = await tx
          .select({ id: task.id })
          .from(task)
          .where(
            and(
              eq(task.kind, ACCOUNT_DELETION_TASK_KIND),
              eq(task.sourceType, "tenant_user"),
              eq(task.sourceId, tenantUserId),
              inArray(task.status, ["open", "in_progress"]),
              isNull(task.deletedAt),
            ),
          )
          .limit(1);
        return {
          row,
          devices: devices.length,
          latest: latest ?? null,
          waiting: [...owned.values()].reduce((sum, n) => sum + n, 0),
          toHandOver: await entriesToHandOver(tx, tenantUserId, devices),
          requestOpen: open.length > 0,
          // Whether they work elsewhere is shown only once the membership here has ended
          // (security review M3): until then it is another organisation's business.
          others: row.authUserId && row.state === "left" ? await elsewhere(tx, tenantUserId) : 0,
        };
      });
      if (!found) {
        await writeAudit(services.appPool, access, {
          action: LIFECYCLE_VIEWED,
          outcome: "denied",
          resourceType: "tenant_user",
          resourceId: tenantUserId,
          reason: "not_found_or_out_of_scope",
          requestId: c.get("requestId"),
        });
        throw problems.notFound();
      }
      const { row } = found;
      const signIn = row.authUserId
        ? found.others > 0
          ? ("kept_other_organisation" as const)
          : ("kept" as const)
        : row.erasedAt
          ? ("erased" as const)
          : ("none" as const);
      return c.json(
        {
          id: tenantUserId,
          displayName: row.displayName,
          jobTitle: row.jobTitle,
          state: row.state,
          statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
          deletionRequestedAt: row.requestedAt?.toISOString() ?? null,
          deletionRequestOpen: found.requestOpen,
          signIn,
          signInErasedAt: row.erasedAt?.toISOString() ?? null,
          entriesWaiting: found.waiting,
          entriesToHandOver: found.toHandOver,
          devicesUsed: found.devices,
          lastReportedAt: found.latest?.toISOString() ?? null,
          mayReinstate:
            tenantUserId !== access.tenantUserId &&
            (row.state === "suspended" ||
              (row.state === "left" &&
                row.erasedAt === null &&
                row.requestedAt === null &&
                organisationWide(access))),
        },
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
        "platform.user.manage with step-up (H-566). Only for an ended membership (409 membership_not_ended otherwise), and only when the sign-in has no membership in any other organisation that has not ended (suspended included) and is not a Harbour operator's (409 sign_in_in_use: kept, since it is theirs to use elsewhere). Deletes the sign-in identity: its email address, password hash, passkeys, TOTP secret, every session and every verification token naming it. The organisation's own copy of the address stays on the member row with the staff file. The member row stays, unlinked, with its display name and job title, so care records stay attributable. An open account deletion request for the member closes as done. Audited before the identity goes (platform.member.sign_in_erased; the request's closure platform.account_deletion.completed), by opaque id only. A sign-in already erased changes nothing (erased false). Same reach and refusals as suspending.",
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
            otherMemberships: await elsewhere(tx, tenantUserId),
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
        // Exactly what goes: the sign-in, never the member row, whose display name, job title and
        // the organisation's own copy of the address stay with the staff file (staff_file).
        scope: ERASED_SCOPE,
        requestId,
      });
      try {
        await eraseSignInIdentity(services.authPool, plan);
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
      const deletionRequestClosed = await withAuditedRefusal(c, access, () =>
        inSystemView(services.db, access, async (tx) => {
          // The link goes through the database, which removes it only from an ended membership.
          await changeInDatabase(tx, tenantUserId, "unlink_sign_in", ERASED);
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
        }),
      );
      return c.json({ tenantUserId, erased: true, deletionRequestClosed }, 200);
    },
  );
