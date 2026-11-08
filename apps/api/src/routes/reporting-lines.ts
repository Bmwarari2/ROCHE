import {
  AddStaffTeamMember,
  ChangeStaffTeam,
  ChangeStaffTeamMember,
  CreateStaffTeam,
  LineManagement,
  SetLineManager,
  StaffTeamItem,
  StaffTeamList,
  StaffTeamMemberItem,
  StaffTeamMemberList,
} from "@harbour/contracts";
import { staffLineManager, staffTeam, staffTeamMember, type Transaction } from "@harbour/db";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { AuditedRefusal, withAuditedRefusal, writeAudit } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { staffNames } from "../services/staff";
import { isCurrentStaff } from "../services/staff-files";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode } from "./people-shared";

/**
 * Reporting lines (ADR-0137, amending ADR-0136; workforce.md section 3, rule 7): a member's line
 * manager over time, and staff teams with their leads. Maintained by organisation-wide holders of
 * workforce.staff_file.manage (HR); read by HR, by the members a line is about, and by holders of a
 * development read permission whose scope covers the member. A line manager's current direct
 * reports and a team lead's current team widen the development scope they already hold; the
 * relationship grants no permission by itself. Every change is audited with opaque ids and keeps a
 * version. The database enforces the same (migration 0162).
 */

const MANAGE = "workforce.staff_file.manage";
const READERS = [
  MANAGE,
  "workforce.staff_file.read",
  "workforce.training.manage",
  "workforce.competence.observe",
  "workforce.supervision.manage",
  "workforce.self.read",
] as const;
const STAFF_READERS = [
  MANAGE,
  "workforce.staff_file.read",
  "workforce.training.manage",
  "workforce.competence.observe",
  "workforce.supervision.manage",
] as const;
const A = {
  lineSet: "workforce.line_manager.set",
  teamCreated: "workforce.staff_team.created",
  teamChanged: "workforce.staff_team.changed",
  memberAdded: "workforce.staff_team_member.added",
  memberChanged: "workforce.staff_team_member.changed",
  refused: "workforce.reporting_line.refused",
} as const;
const tags = ["workforce"];

const MemberParam = z.object({ memberId: z.uuid() });
const TeamParam = z.object({ teamId: z.uuid() });
const MembershipParam = z.object({ teamId: z.uuid(), membershipId: z.uuid() });

/** Only organisation-wide HR maintains reporting lines; anyone else is refused in words, audited. */
async function requireHr(c: Context<AppEnv>): Promise<TenantAccess> {
  const access = await requirePermission(c, MANAGE);
  const everywhere = await withTenant(c, async (tx) => {
    const r = await tx.execute<{ ok: boolean }>(
      sql`SELECT app.holds_staff_permission_everywhere(${MANAGE}) AS ok`,
    );
    return r.rows[0]?.ok === true;
  });
  if (!everywhere) {
    await writeAudit(c.get("services").appPool, access, {
      action: A.refused,
      outcome: "denied",
      resourceType: "reporting_line",
      reason: "reporting_lines_organisation_wide",
      requestId: c.get("requestId"),
    });
    throw new HttpProblem(
      403,
      "reporting_lines_organisation_wide",
      "Only HR changes line managers and teams.",
      "Reporting lines cover staff at every home, so HR keeps them. Ask HR to make the change.",
    );
  }
  return access;
}

const refusal = (
  status: 403 | 409 | 422,
  code: string,
  title: string,
  action: string,
  resourceType: string,
  resourceId: string,
) =>
  new AuditedRefusal(new HttpProblem(status, code, title), {
    action,
    outcome: "denied",
    resourceType,
    resourceId,
    scope: { problems: [code] },
  });

async function lineManagementOf(tx: Transaction, memberId: string) {
  const rows = await tx
    .select()
    .from(staffLineManager)
    .where(and(eq(staffLineManager.workerId, memberId), isNull(staffLineManager.deletedAt)))
    .orderBy(desc(staffLineManager.validFrom));
  const names = await staffNames(
    tx,
    rows.map((r) => r.managerId),
  );
  const item = (r: (typeof rows)[number]) => ({
    id: r.id,
    managerId: r.managerId,
    managerName: names(r.managerId)?.displayName ?? "",
    validFrom: r.validFrom,
    validTo: r.validTo,
    version: r.version,
  });
  const current = rows.find((r) => r.validTo === null);
  return {
    memberId,
    current: current ? item(current) : null,
    history: rows.filter((r) => r !== current).map(item),
  };
}

const teamItem = (t: typeof staffTeam.$inferSelect) => ({
  id: t.id,
  name: t.name,
  locationId: t.locationId,
  archived: t.archivedAt !== null,
  version: t.version,
});

export const reportingLinesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/members/{memberId}/line-manager",
      tags,
      summary: "A member's line manager, now and before",
      description:
        "HR, the member themselves, or a holder of a development read permission whose scope covers the member (ADR-0137). Anyone else gets 404. Audited.",
      security,
      request: { params: MemberParam },
      responses: {
        200: jsonBody(LineManagement, "The line management"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, READERS);
      const { memberId } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const r = await tx.execute<{ ok: boolean }>(
          sql`SELECT (${memberId}::uuid = app.current_user_id()
                OR app.holds_staff_permission_everywhere(${MANAGE})
                OR app.reads_development_of(${memberId}::uuid)) AS ok`,
        );
        if (r.rows[0]?.ok !== true) throw problems.notFound();
        await audit(c, tx, access, {
          action: "workforce.line_manager.viewed",
          resourceType: "tenant_user",
          resourceId: memberId,
        });
        return lineManagementOf(tx, memberId);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/members/{memberId}/line-manager",
      tags,
      summary: "Set or end a member's line manager",
      description:
        "Organisation-wide workforce.staff_file.manage (HR) only; anyone else 403 reporting_lines_organisation_wide. From the day given, the current line ends (against its version) and, when a manager is named, a new one starts. Never oneself as one's own line manager (422 line_manager_is_member); both must be current members of staff (422 not_current_staff); the change starts after the current line did (422 starts_too_early). Audited.",
      security,
      request: {
        params: MemberParam,
        body: { content: { "application/json": { schema: SetLineManager } } },
      },
      responses: {
        200: jsonBody(LineManagement, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireHr(c);
      const { memberId } = c.req.valid("param");
      const body = c.req.valid("json");
      const deny = (status: 403 | 409 | 422, code: string, title: string) =>
        refusal(status, code, title, A.lineSet, "tenant_user", memberId);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          if (body.managerId === memberId) {
            throw deny(422, "line_manager_is_member", "A member cannot be their own line manager.");
          }
          for (const who of [memberId, body.managerId]) {
            if (who && !(await isCurrentStaff(tx, who))) {
              throw deny(422, "not_current_staff", "Choose a current member of staff.");
            }
          }
          const [current] = await tx
            .select()
            .from(staffLineManager)
            .where(
              and(
                eq(staffLineManager.workerId, memberId),
                isNull(staffLineManager.validTo),
                isNull(staffLineManager.deletedAt),
              ),
            )
            .for("update");
          if (current) {
            if (body.expectedVersion !== current.version) throw problems.conflict();
            if (body.from <= current.validFrom) {
              throw deny(
                422,
                "starts_too_early",
                "The change must start after the current line did.",
              );
            }
            const [ended] = await tx
              .update(staffLineManager)
              .set({ validTo: body.from })
              .where(
                and(
                  eq(staffLineManager.id, current.id),
                  eq(staffLineManager.version, current.version),
                ),
              )
              .returning({ id: staffLineManager.id });
            if (!ended) throw problems.conflict();
          } else if (body.expectedVersion !== null) {
            throw problems.conflict();
          }
          if (body.managerId) {
            await tx.insert(staffLineManager).values({
              workerId: memberId,
              managerId: body.managerId,
              validFrom: body.from,
            });
          }
          await audit(c, tx, access, {
            action: A.lineSet,
            resourceType: "tenant_user",
            resourceId: memberId,
            scope: { managerId: body.managerId, from: body.from, ended: current?.id ?? null },
          });
          return lineManagementOf(tx, memberId);
        }),
      );
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/teams",
      tags,
      summary: "Staff teams",
      description:
        "HR, or anyone holding a development read permission. Names and homes only; members are listed per team. Archived teams last.",
      security,
      responses: { 200: jsonBody(StaffTeamList, "The teams"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, STAFF_READERS);
      const teams = await withTenant(c, (tx) =>
        tx
          .select()
          .from(staffTeam)
          .where(isNull(staffTeam.deletedAt))
          .orderBy(sql`${staffTeam.archivedAt} IS NOT NULL`, asc(staffTeam.name)),
      );
      return c.json({ teams: teams.map(teamItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/teams",
      tags,
      summary: "Create a staff team",
      description:
        "Organisation-wide workforce.staff_file.manage (HR) only. A name unique among the teams in use (409 team_name_taken). Audited.",
      security,
      request: { body: { content: { "application/json": { schema: CreateStaffTeam } } } },
      responses: {
        201: jsonBody(StaffTeamItem, "Created"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireHr(c);
      const body = c.req.valid("json");
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [row] = await tx
            .insert(staffTeam)
            .values({ name: body.name, locationId: body.locationId })
            .returning()
            .catch((error: unknown) => {
              if (dbCode(error) === "23505") {
                throw new HttpProblem(
                  409,
                  "team_name_taken",
                  "A team in use already has that name.",
                );
              }
              throw error;
            });
          if (!row) throw problems.conflict();
          await audit(c, tx, access, {
            action: A.teamCreated,
            resourceType: "staff_team",
            resourceId: row.id,
          });
          return teamItem(row);
        }),
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/teams/{teamId}",
      tags,
      summary: "Rename, move or archive a staff team",
      description:
        "Organisation-wide workforce.staff_file.manage (HR) only, against the version you loaded. An archived team widens no one's scope. Audited.",
      security,
      request: {
        params: TeamParam,
        body: { content: { "application/json": { schema: ChangeStaffTeam } } },
      },
      responses: {
        200: jsonBody(StaffTeamItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireHr(c);
      const { teamId } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const [before] = await tx.select().from(staffTeam).where(eq(staffTeam.id, teamId));
        if (!before || before.deletedAt) throw problems.notFound();
        const [row] = await tx
          .update(staffTeam)
          .set({
            name: body.name,
            locationId: body.locationId,
            archivedAt: body.archived ? (before.archivedAt ?? new Date()) : null,
          })
          .where(and(eq(staffTeam.id, teamId), eq(staffTeam.version, body.expectedVersion)))
          .returning()
          .catch((error: unknown) => {
            if (dbCode(error) === "23505") {
              throw new HttpProblem(409, "team_name_taken", "A team in use already has that name.");
            }
            throw error;
          });
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: A.teamChanged,
          resourceType: "staff_team",
          resourceId: teamId,
          scope: { archived: body.archived },
        });
        return teamItem(row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/workforce/teams/{teamId}/members",
      tags,
      summary: "A staff team's members, now and before",
      description:
        "HR, or a holder of a development read permission: members are listed only where the reader's scope covers them (ADR-0137). Audited.",
      security,
      request: { params: TeamParam },
      responses: {
        200: jsonBody(StaffTeamMemberList, "The members"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, READERS);
      const { teamId } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const [team] = await tx.select().from(staffTeam).where(eq(staffTeam.id, teamId));
        if (!team || team.deletedAt) throw problems.notFound();
        const rows = await tx
          .select()
          .from(staffTeamMember)
          .where(and(eq(staffTeamMember.teamId, teamId), isNull(staffTeamMember.deletedAt)))
          .orderBy(desc(staffTeamMember.isLead), asc(staffTeamMember.validFrom));
        const names = await staffNames(
          tx,
          rows.map((r) => r.memberId),
        );
        await audit(c, tx, access, {
          action: "workforce.staff_team_member.viewed",
          resourceType: "staff_team",
          resourceId: teamId,
          scope: { count: rows.length },
        });
        return {
          teamId,
          members: rows.map((r) => ({
            id: r.id,
            memberId: r.memberId,
            name: names(r.memberId)?.displayName ?? "",
            isLead: r.isLead,
            validFrom: r.validFrom,
            validTo: r.validTo,
            version: r.version,
          })),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/workforce/teams/{teamId}/members",
      tags,
      summary: "Add a member to a staff team",
      description:
        "Organisation-wide workforce.staff_file.manage (HR) only. A current member of staff (422 not_current_staff), once at a time per team (409 already_a_member), never to an archived team (422 team_archived). Audited.",
      security,
      request: {
        params: TeamParam,
        body: { content: { "application/json": { schema: AddStaffTeamMember } } },
      },
      responses: {
        201: jsonBody(StaffTeamMemberItem, "Added"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireHr(c);
      const { teamId } = c.req.valid("param");
      const body = c.req.valid("json");
      const deny = (status: 403 | 409 | 422, code: string, title: string) =>
        refusal(status, code, title, A.memberAdded, "staff_team", teamId);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [team] = await tx.select().from(staffTeam).where(eq(staffTeam.id, teamId));
          if (!team || team.deletedAt) throw problems.notFound();
          if (team.archivedAt) throw deny(422, "team_archived", "This team is archived.");
          if (!(await isCurrentStaff(tx, body.memberId))) {
            throw deny(422, "not_current_staff", "Choose a current member of staff.");
          }
          const [row] = await tx
            .insert(staffTeamMember)
            .values({ teamId, memberId: body.memberId, isLead: body.isLead, validFrom: body.from })
            .returning()
            .catch((error: unknown) => {
              if (dbCode(error) === "23505") {
                throw deny(409, "already_a_member", "They are already in this team.");
              }
              throw error;
            });
          if (!row) throw problems.conflict();
          const names = await staffNames(tx, [row.memberId]);
          await audit(c, tx, access, {
            action: A.memberAdded,
            resourceType: "staff_team",
            resourceId: teamId,
            scope: { memberId: row.memberId, isLead: row.isLead },
          });
          return {
            id: row.id,
            memberId: row.memberId,
            name: names(row.memberId)?.displayName ?? "",
            isLead: row.isLead,
            validFrom: row.validFrom,
            validTo: row.validTo,
            version: row.version,
          };
        }),
      );
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/workforce/teams/{teamId}/members/{membershipId}",
      tags,
      summary: "Change or end a team membership",
      description:
        "Organisation-wide workforce.staff_file.manage (HR) only, against the version you loaded: whether they lead the team, and the day it ends (after it started, 422 ends_too_early). An ended membership stays ended. Audited.",
      security,
      request: {
        params: MembershipParam,
        body: { content: { "application/json": { schema: ChangeStaffTeamMember } } },
      },
      responses: {
        200: jsonBody(StaffTeamMemberItem, "Saved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireHr(c);
      const { teamId, membershipId } = c.req.valid("param");
      const body = c.req.valid("json");
      const deny = (status: 403 | 409 | 422, code: string, title: string) =>
        refusal(status, code, title, A.memberChanged, "staff_team", teamId);
      const out = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [before] = await tx
            .select()
            .from(staffTeamMember)
            .where(and(eq(staffTeamMember.id, membershipId), eq(staffTeamMember.teamId, teamId)));
          if (!before || before.deletedAt) throw problems.notFound();
          if (before.validTo !== null) {
            throw deny(422, "membership_ended", "This membership has ended.");
          }
          if (body.endsOn !== null && body.endsOn <= before.validFrom) {
            throw deny(422, "ends_too_early", "It must end after it started.");
          }
          const [row] = await tx
            .update(staffTeamMember)
            .set({ isLead: body.isLead, validTo: body.endsOn })
            .where(
              and(
                eq(staffTeamMember.id, membershipId),
                eq(staffTeamMember.version, body.expectedVersion),
              ),
            )
            .returning();
          if (!row) throw problems.conflict();
          const names = await staffNames(tx, [row.memberId]);
          await audit(c, tx, access, {
            action: A.memberChanged,
            resourceType: "staff_team",
            resourceId: teamId,
            scope: { memberId: row.memberId, isLead: row.isLead, ended: row.validTo !== null },
          });
          return {
            id: row.id,
            memberId: row.memberId,
            name: names(row.memberId)?.displayName ?? "",
            isLead: row.isLead,
            validFrom: row.validFrom,
            validTo: row.validTo,
            version: row.version,
          };
        }),
      );
      return c.json(out, 200);
    },
  );
