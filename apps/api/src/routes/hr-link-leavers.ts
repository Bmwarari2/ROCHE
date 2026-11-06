import { hrPersonLink, leaverRecord, staffProfile } from "@harbour/db";
import { ukIsoDate } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import { requirePermission, stepUpRefusal, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { hrConnection, hrLinkEnabled, leavingOf, raiseHrAlert } from "../integrations/hr-link";
import { publish } from "../outbox";
import { withSystemRights } from "../services/system-rights";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
  unavailableResponse,
} from "./openapi";

/**
 * Withdrawing a wrong leaving date that came from Thapsus-HR (integrations.md section 11.5 rule
 * 8; HZ-133). A leaving date is applied fail-safe and never moved later by a sync, so a person
 * corrects a wrong one here: with `workforce.staff_file.manage` on that file, a fresh step-up and
 * a coded reason. Never while Thapsus-HR still gives the date: that is raised for review instead,
 * and the date is corrected in Thapsus-HR first. Only before access has ended: a member whose
 * access has ended is left (migration 0129 makes that final), so the withdrawal is refused in
 * words until reinstatement exists on app.change_membership (the member lifecycle rework; batch 3c
 * decision). Until then Thapsus-HR may show the person active while Harbour shows them left
 * (HZ-133).
 */

export const WITHDRAW_REASONS = [
  "date_entered_in_error",
  "leaving_cancelled",
  "invalid_date_from_hr_platform",
  "other_recorded_in_staff_file",
] as const;

const Withdrawn = z.object({ withdrawn: z.literal(true) }).meta({ id: "HrLeavingWithdrawn" });

export const hrLinkLeaversRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/v1/integrations/hr-link/leavers/{staffProfileId}/withdraw",
    tags: ["integrations"],
    summary: "Withdraw a wrong leaving date from the HR platform (step-up)",
    description:
      "Refused while Thapsus-HR still gives the date (raised for review instead), and once the member's access has ended (409 hr_link_access_ended: reinstatement is the member lifecycle's).",
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
      // A member whose access has ended has left, which only reinstatement undoes (0129).
      if (leaving.accessRemovedAt !== null) {
        throw new HttpProblem(
          409,
          "hr_link_access_ended",
          "This person's access has already ended, so their leaving date cannot be withdrawn here.",
          "To give them access again, invite them again. When reinstating is available, someone who manages members across the organisation can reinstate them instead.",
        );
      }
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
      await auditInTx(tx, access, {
        action: "integrations.hr_link.leaving_withdrawn",
        resourceType: "staff_profile",
        resourceId: staffProfileId,
        reason,
      });
      await publish(tx, {
        context: "integrations",
        aggregateType: "staff_profile",
        aggregateId: staffProfileId,
        type: "integrations.hr_link.leaving_withdrawn",
        payload: { reason },
      });
      return { refused: false as const };
    });
    if (outcome.refused) {
      throw new HttpProblem(
        409,
        "hr_link_leaving_still_sent",
        "The HR platform still gives this leaving date. Correct it there first; it is shown for review.",
      );
    }
    return c.json({ withdrawn: true as const }, 200);
  },
);
