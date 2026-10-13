import { RevokeMemberSessions, RevokeMemberSessionsResult } from "@harbour/contracts";
import { authSession, deviceBinding, type Transaction, tenantUser } from "@harbour/db";
import { scopeFor } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { writeAudit } from "../http/audit";
import { requirePermission, type TenantAccess } from "../http/context";
import { problems } from "../http/problem";
import { accessRowsOfMember } from "../services/access-rows";
import { lastReportedWaiting } from "../services/device-holds";
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
 * belong to the person's identity, not to one organisation, so the person is signed out
 * everywhere they work; they can sign in again at once unless they have also been suspended.
 */

export const SIGN_OUT_ACTION = "platform.session.revoked_for_member";
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
      "Ends every session of the member's identity, on every device and in every organisation they belong to (platform.user.manage, step-up), with a coded reason, audited. A location role reaches only members whose roles and grants in force are all at its locations; anyone else reads as not found. When the member's devices last reported entries waiting, the sign-out needs confirmEntriesWaiting (409 entries_waiting otherwise): the entries stay on the device, protected, until the member signs in again to send them.",
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
    const now = new Date();
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
      return { authUserId: member.authUserId, waiting };
    });
    if (!target) throw problems.notFound();
    if (target.waiting > 0 && confirmEntriesWaiting !== true) {
      throw problems.memberEntriesWaiting(target.waiting);
    }
    const revoked = target.authUserId
      ? (
          await drizzle(services.authPool)
            .delete(authSession)
            .where(eq(authSession.userId, target.authUserId))
            .returning({ id: authSession.id })
        ).length
      : 0;
    await writeAudit(services.appPool, access, {
      action: SIGN_OUT_ACTION,
      resourceType: "tenant_user",
      resourceId: tenantUserId,
      reason: reasonCode,
      scope: { reasonCode, revoked, entriesWaiting: target.waiting },
      requestId: c.get("requestId"),
    });
    return c.json({ revoked, entriesWaiting: target.waiting }, 200);
  },
);
