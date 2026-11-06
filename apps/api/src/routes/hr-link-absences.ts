import { createRoute, z } from "@hono/zod-openapi";
import { auditInTx } from "../http/audit";
import { requirePermission, stepUpRefusal, withTenant } from "../http/context";
import { HttpProblem } from "../http/problem";
import { hrConnection, hrLinkEnabled } from "../integrations/hr-link";
import { releaseHrCopies } from "../integrations/hr-rota";
import { publish } from "../outbox";
import { withSystemRights } from "../services/system-rights";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  security,
  unavailableResponse,
} from "./openapi";

/**
 * Releasing Thapsus-HR absence copies the link can no longer keep right (integrations.md section
 * 11.3 rule 13; HZ-133). Many copies dropping out of Thapsus-HR's list at once are held, still
 * blocking the rota, until a person with `integrations.hr_link.manage`, after a fresh step-up and
 * with a coded reason, releases them; the list is read again from Thapsus-HR at that moment. Once
 * the link is disconnected (or turned off), the same action ends the copies still in force. The
 * person states how many they expect: a different number now releases nothing.
 */

export const RELEASE_REASONS = [
  "checked_in_hr_platform",
  "link_ended",
  "other_recorded_in_review",
] as const;

const Released = z
  .object({ released: z.number().int(), mode: z.enum(["drift", "disconnected"]) })
  .meta({ id: "HrCopiesReleased" });

export const hrLinkAbsencesRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/v1/integrations/hr-link/absences/release",
    tags: ["integrations"],
    summary: "Release absence copies the HR platform no longer lists (step-up)",
    description:
      "While linked, cancels the copies the drift guard held, read again from Thapsus-HR now. Once the link is disconnected or off, cancels every copy still in force. Refused with the current number when it differs from expectedCount.",
    security,
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                expectedCount: z.number().int().min(1).max(10_000),
                reason: z.enum(RELEASE_REASONS),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: jsonBody(Released, "Released"),
      ...errorResponses,
      ...conflictResponse,
      ...unavailableResponse,
    },
  }),
  async (c) => {
    const access = await requirePermission(c, "integrations.hr_link.manage");
    if (!access.stepUpFresh) throw stepUpRefusal(access);
    const { expectedCount, reason } = c.req.valid("json");
    const services = c.get("services");
    const out = await withTenant(c, async (tx) => {
      const connection = await hrConnection(tx);
      const linked = connection?.status === "connected" && (await hrLinkEnabled(tx));
      const port =
        linked && connection ? services.hrLink.port(access.tenantId, connection.settings) : null;
      if (linked && !port) {
        throw new HttpProblem(
          503,
          "hr_link_unavailable",
          "The HR platform cannot be read just now, so nothing was released. Try again later.",
        );
      }
      const now = new Date();
      const result = await withSystemRights(tx, () =>
        releaseHrCopies(
          tx,
          access.tenantId,
          port && connection ? { port, settings: connection.settings } : null,
          now,
          { expected: expectedCount, by: access.tenantUserId },
        ),
      );
      if (result.error === "drift_changed") {
        throw new HttpProblem(
          409,
          "hr_link_drift_changed",
          `The number of absences to release is now ${result.held}, not ${expectedCount}. Check them again; nothing was released.`,
        );
      }
      if (result.error) {
        throw new HttpProblem(
          503,
          "hr_link_unavailable",
          "The HR platform list could not be read in full, so nothing was released. Try again later.",
        );
      }
      const mode = port ? "drift" : "disconnected";
      await auditInTx(tx, access, {
        action: "integrations.hr_link.drift_released",
        resourceType: "integration_connection",
        resourceId: connection?.id ?? access.tenantId,
        reason,
        scope: { released: result.cancelled, expected: expectedCount, mode },
      });
      await publish(tx, {
        context: "integrations",
        aggregateType: "integration_connection",
        aggregateId: connection?.id ?? access.tenantId,
        type: "integrations.hr_link.drift_released",
        payload: { released: result.cancelled, mode },
      });
      return { released: result.cancelled, mode } as const;
    });
    return c.json(out, 200);
  },
);
