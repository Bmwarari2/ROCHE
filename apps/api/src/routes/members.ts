import { CreateMember, MemberCreated, MemberList, MemberListQuery } from "@harbour/contracts";
import { location, role, roleAssignment, tenantUser } from "@harbour/db";
import { scopeFor } from "@harbour/domain";
import { createRoute } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { auditInTx, writeAudit } from "../http/audit";
import { requirePermission } from "../http/context";
import { HttpProblem } from "../http/problem";
import { inSystemView } from "../services/devices";
import { membersReached } from "./member-sessions";
import { conflictResponse, createRouter, errorResponses, jsonBody, security } from "./openapi";
import { dbCode, requireStepUp } from "./people-shared";

/**
 * Members of staff for managers (PLAT-004; platform.md, Members). Both routes need
 * `platform.user.manage` and reach only the members it reaches (`membersReached`, as the
 * invitation routes and the admin sign-out do): a location role only members wholly at its homes.
 * Adding a member needs step-up and gives one role only where the manager holds every permission
 * of it there (`app.may_assign_role`, enforced again by row-level security, migration 0060, and
 * then `app.may_invite` on the new member). The address is stored, never returned or audited.
 */

const PERMISSION = "platform.user.manage";
const CREATED = "platform.member.created";
const LISTED = ["invited", "active", "suspended"] as const;

const problem = (status: 403 | 409, code: string, title: string, detail: string) =>
  new HttpProblem(status, code, title, detail);

const REFUSALS = {
  email_in_use: () =>
    problem(
      409,
      "email_in_use",
      "This email address is already in use.",
      "Someone in the organisation already has this email address. Find them in the list instead.",
    ),
  member_id_conflict: () =>
    problem(
      409,
      "member_id_conflict",
      "This member was added differently.",
      "A member with this id already exists with other details. Reload the page and try again.",
    ),
  beyond_inviter: () =>
    problem(
      403,
      "beyond_inviter",
      "You cannot give this role here.",
      "The role includes permissions you do not hold where it would apply.",
    ),
} as const;
type Refusal = keyof typeof REFUSALS;

const constraintOf = (error: unknown): string | undefined =>
  (error as { constraint?: string }).constraint ??
  (error as { cause?: { constraint?: string } }).cause?.constraint;

/** Rolls the transaction back with a refusal. */
class Refused extends Error {
  constructor(readonly reason: Refusal) {
    super(reason);
  }
}

export const membersRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/members",
      tags: ["platform"],
      summary: "Members of staff a manager reaches, and the roles they may give",
      description:
        "platform.user.manage: the invited, active and suspended members it reaches (a location role only members wholly at its locations), with their roles in force or to come, and each role the manager may give with where (app.may_assign_role). Never an address or a sign-in.",
      security,
      request: { query: MemberListQuery },
      responses: { 200: jsonBody(MemberList, "Members, by name"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      const { locationId } = c.req.valid("query");
      const now = new Date();
      const body = await inSystemView(c.get("services").db, access, async (tx) => {
        const members = await tx
          .select({
            id: tenantUser.id,
            displayName: tenantUser.displayName,
            state: tenantUser.status,
          })
          .from(tenantUser)
          .where(and(isNull(tenantUser.deletedAt), inArray(tenantUser.status, [...LISTED])))
          .orderBy(asc(tenantUser.displayName), asc(tenantUser.id));
        const reached = await membersReached(
          tx,
          access,
          members.map((m) => m.id),
          now,
        );
        const ids = members.filter((m) => reached.has(m.id)).map((m) => m.id);
        const roles =
          ids.length === 0
            ? []
            : await tx
                .select({
                  tenantUserId: roleAssignment.tenantUserId,
                  roleId: roleAssignment.roleId,
                  roleName: role.name,
                  locationId: roleAssignment.locationId,
                })
                .from(roleAssignment)
                .innerJoin(
                  role,
                  and(
                    eq(role.id, roleAssignment.roleId),
                    eq(role.tenantId, roleAssignment.tenantId),
                  ),
                )
                .where(
                  and(
                    inArray(roleAssignment.tenantUserId, ids),
                    isNull(roleAssignment.deletedAt),
                    isNull(role.deletedAt),
                    or(isNull(roleAssignment.validTo), gt(roleAssignment.validTo, now)),
                  ),
                )
                .orderBy(desc(roleAssignment.validFrom));
        const { scope, locationIds } = scopeFor(access.effective, PERMISSION);
        const places: (string | null)[] =
          scope === "tenant"
            ? [
                null,
                ...(
                  await tx
                    .select({ id: location.id })
                    .from(location)
                    .where(isNull(location.deletedAt))
                ).map((l) => l.id),
              ]
            : [...locationIds];
        const assignable =
          places.length === 0
            ? []
            : (
                await tx.execute<{ id: string; name: string; places: (string | null)[] }>(
                  sql`SELECT r.id, r.name, array_agg(p.place ORDER BY p.place NULLS FIRST) AS places
                        FROM role r
                        CROSS JOIN unnest(ARRAY[${sql.join(
                          places.map((p) => sql`${p}::uuid`),
                          sql`, `,
                        )}]) AS p(place)
                       WHERE app.may_assign_role(r.id, p.place)
                       GROUP BY r.id, r.name
                       ORDER BY r.name`,
                )
              ).rows;
        const items = members
          .filter((m) => reached.has(m.id))
          .map((m) => ({
            id: m.id,
            displayName: m.displayName,
            state: m.state as (typeof LISTED)[number],
            roles: roles
              .filter((r) => r.tenantUserId === m.id)
              .map(({ roleId, roleName, locationId: at }) => ({
                roleId,
                roleName,
                locationId: at,
              })),
          }))
          .filter(
            (m) =>
              !locationId ||
              m.roles.some((r) => r.locationId === null || r.locationId === locationId),
          );
        return {
          items,
          assignableRoles: assignable.map((r) => ({
            id: r.id,
            name: r.name,
            locationIds: r.places,
          })),
        };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/members",
      tags: ["platform"],
      summary: "Add a member of staff as invited, with one role",
      description:
        "platform.user.manage with step-up. Adds the member as invited, required to use a second factor, with one role at a location or across the organisation, only where the manager may give that role (app.may_assign_role; 403 beyond_inviter). Idempotent on the client's id: a retry by the same manager with the same details answers 200 with the same id; other details 409 member_id_conflict. An address already in the organisation is 409 email_in_use. Invite them next with POST /v1/invitations. Audited by opaque id, refusals too; the address never.",
      security,
      request: { body: { content: { "application/json": { schema: CreateMember } } } },
      responses: {
        200: jsonBody(MemberCreated, "Already added by this request's earlier attempt"),
        201: jsonBody(MemberCreated, "Added"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, PERMISSION);
      await requireStepUp(c, access, CREATED);
      const input = c.req.valid("json");
      const email = input.email.trim().toLowerCase();
      const services = c.get("services");
      const requestId = c.get("requestId");
      const scope = { roleId: input.roleId, locationId: input.locationId };
      let outcome: "created" | "replayed";
      try {
        outcome = await inSystemView(services.db, access, async (tx) => {
          const [existing] = await tx
            .select({
              email: tenantUser.email,
              displayName: tenantUser.displayName,
              createdBy: tenantUser.createdBy,
            })
            .from(tenantUser)
            .where(eq(tenantUser.id, input.id));
          if (existing) {
            const [same] = await tx
              .select({ id: roleAssignment.id })
              .from(roleAssignment)
              .where(
                and(
                  eq(roleAssignment.tenantUserId, input.id),
                  eq(roleAssignment.roleId, input.roleId),
                  input.locationId === null
                    ? isNull(roleAssignment.locationId)
                    : eq(roleAssignment.locationId, input.locationId),
                ),
              );
            const replay =
              existing.email === email &&
              existing.displayName === input.displayName.trim() &&
              existing.createdBy === access.tenantUserId &&
              same;
            if (!replay) throw new Refused("member_id_conflict");
            return "replayed";
          }
          const [taken] = await tx
            .select({ id: tenantUser.id })
            .from(tenantUser)
            .where(sql`lower(${tenantUser.email}) = ${email}`);
          if (taken) throw new Refused("email_in_use");
          const [kind] = await tx
            .select({ scopeKind: role.scopeKind })
            .from(role)
            .where(eq(role.id, input.roleId));
          const may = await tx.execute<{ may: boolean }>(
            sql`SELECT app.may_assign_role(${input.roleId}, ${input.locationId}::uuid) AS may`,
          );
          if (!kind || may.rows[0]?.may !== true) throw new Refused("beyond_inviter");
          await tx.insert(tenantUser).values({
            id: input.id,
            displayName: input.displayName.trim(),
            email,
            status: "invited",
            mfaRequired: true,
          });
          await tx.insert(roleAssignment).values({
            tenantUserId: input.id,
            roleId: input.roleId,
            locationId: input.locationId,
            // A location role given across the organisation must say so (ADR-0071 review, L2).
            organisationWide: input.locationId === null && kind.scopeKind === "location",
            reason: "Added by a manager",
          });
          const invitable = await tx.execute<{ may: boolean }>(
            sql`SELECT app.may_invite(${input.id}) AS may`,
          );
          if (invitable.rows[0]?.may !== true) throw new Refused("beyond_inviter");
          await auditInTx(tx, access, {
            action: CREATED,
            resourceType: "tenant_user",
            resourceId: input.id,
            scope,
            requestId,
          });
          return "created";
        });
      } catch (error) {
        const reason: Refusal | null =
          error instanceof Refused
            ? error.reason
            : dbCode(error) === "23505"
              ? constraintOf(error)?.includes("email")
                ? "email_in_use"
                : "member_id_conflict"
              : dbCode(error) === "42501"
                ? "beyond_inviter"
                : null;
        if (!reason) throw error;
        await writeAudit(services.appPool, access, {
          action: CREATED,
          outcome: "denied",
          resourceType: "tenant_user",
          resourceId: input.id,
          reason,
          scope,
          requestId,
        });
        throw REFUSALS[reason]();
      }
      return c.json({ id: input.id }, outcome === "created" ? 201 : 200);
    },
  );
