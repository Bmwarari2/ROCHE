import { ColleagueList } from "@harbour/contracts";
import { tenantUser } from "@harbour/db";
import { PORTAL_ONLY_PERMISSIONS } from "@harbour/domain";
import { createRoute } from "@hono/zod-openapi";
import { and, asc, inArray, isNull, sql } from "drizzle-orm";
import { requireAnyPermission, withTenant } from "../http/context";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * Colleagues to choose from (workforce.md section 5; plan slice 58): an interview panel, a
 * colleague shadowed, a case member. Members of staff on the staff (never a portal account: a
 * member holding a role with no portal permission), by name and job title only, never an
 * address or anything else. For holders of the workforce permissions that name colleagues.
 */
export const colleaguesRouter = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/v1/workforce/colleagues",
    tags: ["workforce"],
    summary: "Colleagues to choose from",
    description:
      "workforce.recruitment.manage, workforce.staff_file.read, workforce.staff_file.manage or workforce.casework.manage. The organisation's members of staff, by name and job title only, for choosing a panel, a colleague shadowed or a case member.",
    security,
    responses: { 200: jsonBody(ColleagueList, "Colleagues"), ...errorResponses },
  }),
  async (c) => {
    await requireAnyPermission(c, [
      "workforce.recruitment.manage",
      "workforce.staff_file.read",
      "workforce.staff_file.manage",
      "workforce.casework.manage",
    ]);
    const portal = sql.raw(
      `ARRAY[${PORTAL_ONLY_PERMISSIONS.map((p) => `'${p}'`).join(", ")}]::text[]`,
    );
    const items = await withTenant(c, (tx) =>
      tx
        .select({
          id: tenantUser.id,
          displayName: tenantUser.displayName,
          jobTitle: tenantUser.jobTitle,
        })
        .from(tenantUser)
        .where(
          and(
            inArray(tenantUser.status, ["invited", "active"]),
            isNull(tenantUser.deletedAt),
            sql`EXISTS (SELECT 1 FROM role_assignment ra
                          JOIN role r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
                         WHERE ra.tenant_id = ${tenantUser.tenantId}
                           AND ra.tenant_user_id = ${tenantUser.id}
                           AND ra.deleted_at IS NULL
                           AND (ra.valid_to IS NULL OR ra.valid_to > now())
                           AND NOT (r.permissions && ${portal}))`,
          ),
        )
        .orderBy(asc(tenantUser.displayName), asc(tenantUser.id))
        .limit(2000),
    );
    return c.json({ items }, 200);
  },
);
