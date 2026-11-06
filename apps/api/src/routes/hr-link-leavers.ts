import { hrPersonLink, leaverRecord, roleAssignment, staffProfile, tenantUser } from "@harbour/db";
import { ukIsoDate } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, stepUpRefusal, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { hrConnection, hrLinkEnabled, leavingOf, raiseHrAlert } from "../integrations/hr-link";
import { publish } from "../outbox";
import { withSystemRights } from "../services/system-rights";
import { conflictResponse, createRouter, errorResponses, jsonBody, notFoundResponse, security, unavailableResponse } from "./openapi";

/**
 * Withdrawing a wrong leaving date that came from Thapsus-HR (integrations.md section 11.5 rule
 * 8; HZ-133). A leaving date is applied fail-safe and never moved later by a sync, so a person
 * corrects a wrong one here: with `workforce.staff_file.manage` on that file, a fresh step-up and
 * a coded reason. Never while Thapsus-HR still gives the date: that is raised for review instead,
 * and the date is corrected in Thapsus-HR first. When access has already ended, sign-in and the
 * roles that leaving ended are given back from now, which needs `platform.user.manage` as any
 * reinstatement does (the database checks the giver may give each role).
 */

export const WITHDRAW_REASONS = [
  "date_entered_in_error",
  "leaving_cancelled",
  "invalid_date_from_hr_platform",
  "other_recorded_in_staff_file",
] as const;

const Withdrawn = z
  .object({ withdrawn: z.literal(true), accessRestored: z.boolean() })
  .meta({ id: "HrLeavingWithdrawn" });

export const hrLinkLeaversRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/v1/integrations/hr-link/leavers/{staffProfileId}/withdraw",
    tags: ["integrations"],
    summary: "Withdraw a wrong leaving date from the HR platform (step-up)",
    description:
      "Refused while Thapsus-HR still gives the date (raised for review instead). When access has already ended, gives back sign-in and the roles that leaving ended, from now.",
    security,
    request: {
      params: z.object({ staffProfileId: z.uuid() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ reason: z.enum(WITHDRAW_REASONS) }).strict(),
          },
        },
      },
    },
    responses: {
      200: jsonBody(Withdrawn, "Withdrawn"),
      ...errorResponses,
      ...notFoundResponse,
      ...conflictResponse,
      ...unavailableResponse,
    },
  }),
  async (c) => {
    const access = await requirePermission(c, "workforce.staff_file.manage");
    if (!access.stepUpFresh) throw stepUpRefusal(access);
    const { staffProfileId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const services = c.get("services");
    const outcome = await withTenant(c, async (tx) => {
      if (!(await hrLinkEnabled(tx))) throw problems.featureDisabled();
      const [file] = await tx
        .select({ id: staffProfile.id, tenantUserId: staffProfile.tenantUserId })
        .from(staffProfile)
        .where(and(eq(staffProfile.id, staffProfileId), isNull(staffProfile.deletedAt)));
      if (!file) throw problems.notFound();
      const manages = await tx.execute<{ ok: boolean }>(
        sql`SELECT app.manages_staff_file_of(${staffProfileId}::uuid) AS ok`,
      );
      if (!manages.rows[0]?.ok) throw problems.forbidden();
      const [leaving] = await tx
        .select()
        .from(leaverRecord)
        .where(and(eq(leaverRecord.staffProfileId, staffProfileId), isNull(leaverRecord.deletedAt)))
        .for("update");
      if (!leaving) throw problems.notFound();
      const [link] = await withSystemRights(tx, () =>
        tx
          .select({
            id: hrPersonLink.id,
            hrEmployeeId: hrPersonLink.hrEmployeeId,
            leavingOn: hrPersonLink.leavingOn,
          })
          .from(hrPersonLink)
          .where(
            and(
              eq(hrPersonLink.staffProfileId, staffProfileId),
              eq(hrPersonLink.state, "linked"),
              isNull(hrPersonLink.deletedAt),
            ),
          ),
      );
      // Only a leaving the link recorded (by the sync, from Thapsus-HR's date) is withdrawn here.
      if (!link || link.leavingOn === null || leaving.createdBy !== null) {
        throw new HttpProblem(
          409,
          "hr_link_leaving_not_from_link",
          "This leaving was not recorded from the HR platform, so it is not withdrawn here.",
        );
      }
      const connection = await hrConnection(tx);
      const port =
        connection?.status === "connected"
          ? services.hrLink.port(access.tenantId, connection.settings)
          : null;
      if (!port) {
        throw new HttpProblem(
          503,
          "hr_link_unavailable",
          "The HR platform cannot be checked just now, so the leaving stays. Try again later.",
        );
      }
      // Thapsus-HR must say positively that there is no leaving: an employee it cannot find
      // (archived or deleted, as leavers often are) keeps the leaving.
      const employee = await port.employee(link.hrEmployeeId);
      if (!employee.ok && employee.error !== "not_found") {
        throw new HttpProblem(
          503,
          "hr_link_unavailable",
          "The HR platform cannot be checked just now, so the leaving stays. Try again later.",
        );
      }
      if (!employee.ok || leavingOf(employee.value, ukIsoDate(new Date())).date !== null) {
        await withSystemRights(tx, () =>
          raiseHrAlert(tx, "leaving_still_sent", "staff_profile", staffProfileId, new Date()),
        );
        return { refused: true as const };
      }
      const accessEnded = leaving.accessRemovedAt !== null;
      type Restore = {
        roleId: string;
        locationId: string | null;
        organisationWide: boolean;
        validTo: Date | null;
      };
      const restore: Restore[] = [];
      if (accessEnded && leaving.accessRemovedAt) {
        // Giving access back is a user manager's, across the organisation (L1).
        const userManager = await tx.execute<{ ok: boolean }>(
          sql`SELECT app.holds_role_permission_at('platform.user.manage', NULL) AS ok`,
        );
        if (!userManager.rows[0]?.ok) {
          throw new HttpProblem(
            403,
            "hr_link_needs_user_manager",
            "This member's access has already ended. Someone who manages members across the organisation withdraws this leaving.",
          );
        }
        const ended = await tx
          .select({
            id: roleAssignment.id,
            roleId: roleAssignment.roleId,
            locationId: roleAssignment.locationId,
            organisationWide: roleAssignment.organisationWide,
          })
          .from(roleAssignment)
          .where(
            and(
              eq(roleAssignment.tenantUserId, file.tenantUserId),
              isNull(roleAssignment.deletedAt),
              gte(roleAssignment.validTo, new Date(leaving.accessRemovedAt.getTime() - 60_000)),
              lte(roleAssignment.validTo, new Date(leaving.accessRemovedAt.getTime() + 60_000)),
            ),
          );
        for (const r of ended) {
          // The end each role had before the leaving cut it short (its earlier version): a role
          // that had ended by now stays ended; a time-boxed one keeps its end (HZ-124).
          const before = await withSystemRights(tx, () =>
            tx.execute<{ valid_to: string | null }>(
              sql`SELECT data ->> 'valid_to' AS valid_to FROM record_version
                   WHERE table_name = 'role_assignment' AND record_id = ${r.id}
                   ORDER BY record_version DESC LIMIT 1`,
            ),
          );
          const was = before.rows[0]?.valid_to ? new Date(before.rows[0].valid_to) : null;
          if (was && was.getTime() <= Date.now()) continue;
          const may = await tx.execute<{ ok: boolean }>(
            sql`SELECT app.may_assign_role(${r.roleId}::uuid, ${r.locationId}::uuid) AS ok`,
          );
          if (!may.rows[0]?.ok) throw problems.forbidden();
          restore.push({ ...r, validTo: was });
        }
      }
      // The leaving, its left-on date and the link's copy go, with the system's rights: these are
      // the sync's and the leaver sweep's fields, never a member's (migrations 0091 and 0141).
      await withSystemRights(tx, async () => {
        await tx
          .update(leaverRecord)
          .set({ deletedAt: new Date(), updatedBy: null })
          .where(eq(leaverRecord.id, leaving.id));
        await tx
          .update(staffProfile)
          .set({ leftOn: null, updatedBy: null })
          .where(
            and(eq(staffProfile.id, staffProfileId), eq(staffProfile.leftOn, leaving.leavingOn)),
          );
        await tx
          .update(hrPersonLink)
          .set({ leavingOn: null, updatedBy: null })
          .where(eq(hrPersonLink.id, link.id));
      });
      if (accessEnded) {
        // From now: sign-in, and the roles the leaving ended, given in the caller's own name.
        await tx
          .update(tenantUser)
          .set({ status: "active" })
          .where(and(eq(tenantUser.id, file.tenantUserId), eq(tenantUser.status, "left")));
        for (const r of restore) {
          await tx.insert(roleAssignment).values({
            tenantUserId: file.tenantUserId,
            roleId: r.roleId,
            locationId: r.locationId,
            organisationWide: r.organisationWide,
            validTo: r.validTo,
            reason: "Leaving withdrawn",
          });
        }
      }
      await auditInTx(tx, access, {
        action: "integrations.hr_link.leaving_withdrawn",
        resourceType: "staff_profile",
        resourceId: staffProfileId,
        reason,
        scope: { accessRestored: accessEnded },
      });
      await publish(tx, {
        context: "integrations",
        aggregateType: "staff_profile",
        aggregateId: staffProfileId,
        type: "integrations.hr_link.leaving_withdrawn",
        payload: { reason, accessRestored: accessEnded },
      });
      return { refused: false as const, accessRestored: accessEnded };
    });
    if (outcome.refused) {
      throw new HttpProblem(
        409,
        "hr_link_leaving_still_sent",
        "The HR platform still gives this leaving date. Correct it there first; it is shown for review.",
      );
    }
    return c.json({ withdrawn: true as const, accessRestored: outcome.accessRestored }, 200);
  },
);
