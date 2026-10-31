import { ColleagueList } from "@harbour/contracts";
import { tenantUser } from "@harbour/db";
import { createRoute } from "@hono/zod-openapi";
import { asc } from "drizzle-orm";
import { requireAnyPermission, withTenant } from "../http/context";
import { isColleague } from "../services/staff";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";
import { audit } from "./people-shared";

/**
 * Colleagues to choose from (workforce.md section 5; plan slice 58): an interview panel, a
 * colleague shadowed, a case member. Members of staff on the staff (never a portal account: a
 * member holding a role with no portal permission), by name and job title only, never an
 * address or anything else. For holders of the workforce permissions that name colleagues. The
 * read is audited without names. It is staff names only, never a care record, so it does not
 * need a verified second factor (workforce.md section 5).
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
    const access = await requireAnyPermission(c, [
      "workforce.recruitment.manage",
      "workforce.staff_file.read",
      "workforce.staff_file.manage",
      "workforce.casework.manage",
    ]);
    const items = await withTenant(c, async (tx) => {
      const rows = await tx
        .select({
          id: tenantUser.id,
          displayName: tenantUser.displayName,
          jobTitle: tenantUser.jobTitle,
        })
        .from(tenantUser)
        .where(isColleague())
        .orderBy(asc(tenantUser.displayName), asc(tenantUser.id))
        .limit(2000);
      // Audited without names: who read the directory, never who was in it.
      await audit(c, tx, access, {
        action: "workforce.colleague.listed",
        resourceType: "tenant_user",
      });
      return rows;
    });
    return c.json({ items }, 200);
  },
);
