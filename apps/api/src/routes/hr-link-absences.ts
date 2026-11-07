import { HR_LINK_PORT } from "@harbour/db";
import { createRoute, z } from "@hono/zod-openapi";
import { auditInTx } from "../http/audit";
import { requirePermission, stepUpRefusal, withTenant } from "../http/context";
import { HttpProblem } from "../http/problem";
import { RateLimiter, requireWithinLimit } from "../http/rate-limit";
import { hrConnection, hrLinkEnabled, ukRefusal } from "../integrations/hr-link";
import { heldHrCopies, hrCopiesInForce, lockRota, releaseHrCopies } from "../integrations/hr-rota";
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
 * the link is disconnected, the same action ends the copies still in force (never while it is
 * connected but turned off: Thapsus-HR may still list them). The person sends the Thapsus-HR ids
 * they reviewed: any other set now releases nothing.
 */

export const RELEASE_REASONS = [
  "checked_in_hr_platform",
  "link_ended",
  "other_recorded_in_review",
] as const;
/** The reasons that fit each mode. */
const REASONS_FOR = {
  drift: ["checked_in_hr_platform", "other_recorded_in_review"],
  disconnected: ["link_ended", "other_recorded_in_review"],
} as const satisfies Record<string, readonly (typeof RELEASE_REASONS)[number][]>;

const Released = z
  .object({ released: z.number().int(), mode: z.enum(["drift", "disconnected"]) })
  .meta({ id: "HrCopiesReleased" });

const Held = z
  .object({
    /** `drift` while linked; `disconnected` once the link has stopped; `none` while it cannot be released. */
    mode: z.enum(["drift", "disconnected", "none"]),
    /** The copies a release would cancel now: Thapsus-HR ids, dates and type only. */
    items: z.array(
      z.object({
        hrId: z.string(),
        memberId: z.uuid(),
        kind: z.string(),
        startsOn: z.iso.date(),
        endsOn: z.iso.date().nullable(),
      }),
    ),
    /** Why the list could not be read now (nothing is offered then), or null. */
    error: z.string().nullable(),
  })
  .meta({ id: "HrCopiesHeld" });

/** Reading the held list calls Thapsus-HR: at most a few times a minute per person. */
const heldLimiter = new RateLimiter("hr_link_held", 6, 60_000);

export const hrLinkAbsencesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/integrations/hr-link/absences/held",
      tags: ["integrations"],
      summary: "The absence copies a release would cancel now (read only)",
      description:
        "While linked, the current copies the HR platform no longer lists, read again from it now; once disconnected, every copy still in force. The release sends these ids back as expectedHrIds. Changes nothing.",
      security,
      responses: { 200: jsonBody(Held, "Copies to release"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "integrations.hr_link.manage");
      // Absence dates and types, and a read of Thapsus-HR's whole list: a fresh step-up, a few a
      // minute, and audited (slice 90 security review).
      if (!access.stepUpFresh) throw stepUpRefusal(access);
      const services = c.get("services");
      await requireWithinLimit(services.db, access, heldLimiter);
      const out = await withTenant(c, async (tx) => {
        await auditInTx(tx, access, {
          action: "integrations.hr_link.held_viewed",
          resourceType: "integration_connection",
          resourceId: HR_LINK_PORT,
        });
        const connection = await hrConnection(tx);
        const enabled = await hrLinkEnabled(tx);
        const linked = connection?.status === "connected";
        if (linked && !enabled) {
          return { mode: "none" as const, items: [], error: "hr_link_off_while_connected" };
        }
        // Copies span the organisation, as the release does: read with the sync's rights.
        if (!linked || !connection) {
          const items = await withSystemRights(tx, () => hrCopiesInForce(tx));
          return { mode: "disconnected" as const, items, error: null };
        }
        const port = services.hrLink.port(access.tenantId, connection.settings);
        if (!port) return { mode: "drift" as const, items: [], error: "hr_link_unavailable" };
        const refusal = await ukRefusal(port, connection.settings);
        if (refusal) return { mode: "drift" as const, items: [], error: refusal };
        const held = await withSystemRights(tx, () => heldHrCopies(tx, port, new Date()));
        return { mode: "drift" as const, ...held };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/integrations/hr-link/absences/release",
      tags: ["integrations"],
      summary: "Release absence copies the HR platform no longer lists (step-up)",
      description:
        "While linked, cancels the copies the drift guard held, read again from Thapsus-HR now. Once the link is disconnected, cancels every copy still in force; refused while it is connected but turned off. Refused, with the current number, when the copies differ from expectedHrIds.",
      security,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  expectedHrIds: z
                    .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
                    .min(1)
                    .max(10_000),
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
      const { expectedHrIds, reason } = c.req.valid("json");
      const services = c.get("services");
      const out = await withTenant(c, async (tx) => {
        // The lock first, so the link cannot be reconnected between this check and the release.
        await lockRota(tx, access.tenantId);
        const connection = await hrConnection(tx);
        const enabled = await hrLinkEnabled(tx);
        if (connection?.status === "connected" && !enabled) {
          throw new HttpProblem(
            409,
            "hr_link_off_while_connected",
            "The link is turned off but still connected, so its absences may still be in the HR platform. Turn it back on, or disconnect it, first.",
          );
        }
        const linked = connection?.status === "connected";
        const port =
          linked && connection ? services.hrLink.port(access.tenantId, connection.settings) : null;
        if (linked && !port) {
          throw new HttpProblem(
            503,
            "hr_link_unavailable",
            "The HR platform cannot be read just now, so nothing was released. Try again later.",
          );
        }
        const mode = linked ? "drift" : "disconnected";
        if (!(REASONS_FOR[mode] as readonly string[]).includes(reason)) {
          throw new HttpProblem(
            422,
            "hr_link_release_reason",
            "Choose a reason that fits this release.",
          );
        }
        const now = new Date();
        const result = await withSystemRights(tx, () =>
          releaseHrCopies(
            tx,
            access.tenantId,
            port && connection ? { port, settings: connection.settings } : null,
            now,
            { expected: expectedHrIds, by: access.tenantUserId },
          ),
        );
        if (result.error === "drift_changed") {
          throw new HttpProblem(
            409,
            "hr_link_drift_changed",
            `The absences to release have changed (${result.held} now). Check them again; nothing was released.`,
          );
        }
        if (result.error) {
          throw new HttpProblem(
            503,
            "hr_link_unavailable",
            "The HR platform list could not be read in full, so nothing was released. Try again later.",
          );
        }
        await auditInTx(tx, access, {
          action: "integrations.hr_link.drift_released",
          resourceType: "integration_connection",
          resourceId: HR_LINK_PORT,
          reason,
          scope: { released: result.cancelled, mode },
        });
        await publish(tx, {
          context: "integrations",
          aggregateType: "integration_connection",
          aggregateId: HR_LINK_PORT,
          type: "integrations.hr_link.drift_released",
          payload: { released: result.cancelled, mode },
        });
        return { released: result.cancelled, mode } as const;
      });
      return c.json(out, 200);
    },
  );
