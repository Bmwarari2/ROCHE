import { RevokeMemberSessions, RevokeMemberSessionsResult } from "@harbour/contracts";
import { authSession, deviceBinding, type Transaction, tenantUser } from "@harbour/db";
import { scopeFor } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, count, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { writeAudit } from "../http/audit";
import { membershipsFor, requirePermission, type TenantAccess } from "../http/context";
import { type HttpProblem, problems } from "../http/problem";
import { accessRowsOfMember } from "../services/access-rows";
import { hurryRevokedHold, lastReportedWaiting } from "../services/device-holds";
import { inSystemView, memberLocations } from "../services/devices";
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
 * A manager signs a member of staff out of every device (section 5.3, session management;
 * platform.md, Identity). `platform.user.manage` with step-up, a coded reason, audited. Sessions
 * belong to the person's sign-in, not to one organisation, so a member who also works for another
 * organisation is not signed out (#40 review M1): that would end their work there too. They can
 * sign in again at once unless they have also been suspended.
 */

export const SIGN_OUT_ACTION = "platform.session.revoked_for_member";
/** Reasons for which the member's held entries are chased at once, as after a revocation. */
const CHASE_HELD: ReadonlySet<string> = new Set(["staff_left", "suspended"]);
const PERMISSION = "platform.user.manage";

const live = (from: Date, to: Date | null, now: Date) =>
  from.getTime() <= now.getTime() && (to === null || to.getTime() > now.getTime());

/**
 * Whether the manager's `platform.user.manage` reaches the member (ADR-0071): across the
 * organisation, anyone; at locations, a member whose every role and grant in force is at one of
 * them (with none in force, where they last worked), never one whose role or grant reaches the
 * whole organisation, so a home's manager cannot sign out the owner or another home's staff.
 */
export async function memberReached(
  tx: Transaction,
  access: TenantAccess,
  memberId: string,
  now: Date,
): Promise<boolean> {
  const { scope, locationIds } = scopeFor(access.effective, PERMISSION);
  if (scope === "tenant") return true;
  if (scope !== "locations") return false;
  const rows = await accessRowsOfMember(tx, memberId);
  const places = [
    ...rows.assignments.filter((a) => live(a.validFrom, a.validTo, now)).map((a) => a.locationId),
    ...rows.grants
      .filter((g) => g.revokedAt === null && live(g.validFrom, g.validTo, now))
      .map((g) => g.locationId),
  ];
  if (places.includes(null)) return false;
  const where =
    places.length > 0
      ? (places as string[])
      : ((await memberLocations(tx, [memberId], now)).get(memberId) ?? []);
  const mine = new Set(locationIds);
  return where.length > 0 && where.every((l) => mine.has(l));
}

export const memberSessionsRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/v1/members/{tenantUserId}/sessions/revoke",
    tags: ["platform"],
    summary: "Sign a member of staff out of every device",
    description:
      "Ends every session of the member's sign-in, on every device (platform.user.manage, step-up), with a coded reason, audited before the sessions end. A location role reaches only members whose roles and grants in force are all at its locations; anyone else reads as not found (audited by opaque id). A member who also works for another organisation in Harbour is not signed out (409 member_of_other_organisation). When the member's devices last reported entries waiting, the sign-out needs confirmEntriesWaiting (409 entries_waiting otherwise): signing out removes the care record from their phone until they sign in again, and the entries not yet sent stay on it until then. For staff_left or suspended, the holds on those devices fall due at once, as after a device revocation.",
    security,
    request: {
      params: z.object({ tenantUserId: z.uuid() }),
      body: { content: { "application/json": { schema: RevokeMemberSessions } } },
    },
    responses: {
      200: jsonBody(RevokeMemberSessionsResult, "Signed out"),
      ...errorResponses,
      ...notFoundResponse,
      ...conflictResponse,
    },
  }),
  async (c) => {
    const access = await requirePermission(c, PERMISSION);
    await requireStepUp(c, access, SIGN_OUT_ACTION);
    const { tenantUserId } = c.req.valid("param");
    const { reasonCode, confirmEntriesWaiting } = c.req.valid("json");
    const services = c.get("services");
    const requestId = c.get("requestId");
    const now = new Date();
    const audit = (outcome: "success" | "denied" | "error", reason: string, scope = {}) =>
      writeAudit(services.appPool, access, {
        action: SIGN_OUT_ACTION,
        outcome,
        resourceType: "tenant_user",
        resourceId: tenantUserId,
        reason,
        scope: { reasonCode, ...scope },
        requestId,
      });
    const refuse = async (reason: string, problem: HttpProblem, scope = {}) => {
      await audit("denied", reason, scope);
      return problem;
    };
    const target = await inSystemView(services.db, access, async (tx) => {
      const [member] = await tx
        .select({ authUserId: tenantUser.authUserId })
        .from(tenantUser)
        .where(and(eq(tenantUser.id, tenantUserId), isNull(tenantUser.deletedAt)));
      if (!member || !(await memberReached(tx, access, tenantUserId, now))) return null;
      const devices = await tx
        .selectDistinct({ id: deviceBinding.deviceId })
        .from(deviceBinding)
        .where(and(eq(deviceBinding.tenantUserId, tenantUserId), isNull(deviceBinding.revokedAt)));
      const reports = await lastReportedWaiting(
        tx,
        devices.map((d) => d.id),
      );
      const waiting = [...reports.values()].reduce((sum, r) => sum + r.waiting, 0);
      return { authUserId: member.authUserId, reports, waiting };
    });
    if (!target) throw await refuse("not_found_or_out_of_scope", problems.notFound());
    if (target.authUserId) {
      const elsewhere = (await membershipsFor(services.appPool, target.authUserId)).filter(
        (m) => m.tenantId !== access.tenantId,
      );
      if (elsewhere.length > 0) {
        throw await refuse("member_of_other_organisation", problems.memberOfAnotherOrganisation());
      }
    }
    if (target.waiting > 0 && confirmEntriesWaiting !== true) {
      throw await refuse("entries_waiting", problems.memberEntriesWaiting(target.waiting), {
        entriesWaiting: target.waiting,
      });
    }
    const auth = drizzle(services.authPool);
    const ofMember = target.authUserId ? eq(authSession.userId, target.authUserId) : null;
    const [held] = ofMember
      ? await auth.select({ n: count() }).from(authSession).where(ofMember)
      : [];
    // Audited before the sessions end: the audit trail and the sessions live under different
    // database roles, so one transaction cannot hold both (#40 review).
    await audit("success", reasonCode, { sessions: held?.n ?? 0, entriesWaiting: target.waiting });
    let revoked = 0;
    try {
      revoked = ofMember
        ? (await auth.delete(authSession).where(ofMember).returning({ id: authSession.id })).length
        : 0;
    } catch (error) {
      await audit("error", "sessions_not_ended");
      throw error;
    }
    // Someone who has left or been suspended will not sign in to send what their phone holds:
    // its hold falls due at once, as after a revocation (#40 review M2).
    if (CHASE_HELD.has(reasonCode)) {
      for (const [deviceId, report] of target.reports) {
        await hurryRevokedHold(services.db, access, {
          deviceId,
          waiting: report.waiting,
          now,
          requestId,
          because: "signed_out",
        });
      }
    }
    return c.json({ revoked, entriesWaiting: target.waiting }, 200);
  },
);
