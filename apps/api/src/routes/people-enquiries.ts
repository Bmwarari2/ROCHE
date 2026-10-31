import { CreateEnquiry, EnquiryRecorded, ServiceList } from "@harbour/contracts";
import { location, person, service } from "@harbour/db";
import { ukIsoDate } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull } from "drizzle-orm";
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
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, dbCode, requireLocationInScope } from "./people-shared";

/**
 * Enquiries (people.md rule 1; the start of PEOP-004): a new person record at `enquiry`, so the
 * pre-admission assessment (rule 4) can start on its own record, and the services at a location
 * an assessment or an admission is for. An enquiry holds names and a date of birth only; the NHS
 * number and the rest follow on the record. The answer carries the record's id and state, never
 * the person's details: `people.enquiry.manage` alone (an administrator) reads no care record.
 * A request sent again with its id is answered as the first only when it is the caller's own
 * enquiry with the same details (HZ-029); any other use of an id is refused and audited by opaque
 * ids (HZ-001, HZ-011).
 */

const LocationParam = z.object({ id: z.uuid() });
const ACTION = "people.person.enquiry";

/** The sample-data guard (migration 0069) refuses a real person while sample people are loaded. */
const SAMPLE_REFUSALS = new Set(["remove_sample_data_first"]);

const ID_IN_USE = "That id is already used.";

/** A refusal about an id, audited after the transaction ends with the id only. */
const idRefusal = (problem: HttpProblem, personId: string, reason: string) =>
  new AuditedRefusal(problem, {
    action: ACTION,
    outcome: "denied",
    resourceType: "person",
    resourceId: personId,
    reason,
  });

/** Audits a refusal decided before any transaction (opaque ids only), then throws it. */
async function refuseOutside(
  c: Context<AppEnv>,
  access: TenantAccess,
  problem: HttpProblem,
  locationId: string,
  reason: string,
): Promise<never> {
  await writeAudit(c.get("services").appPool, access, {
    action: ACTION,
    outcome: "denied",
    resourceType: "location",
    resourceId: locationId,
    reason,
    requestId: c.get("requestId"),
  });
  throw problem;
}

const answer = (
  row: Pick<
    typeof person.$inferSelect,
    "id" | "locationId" | "status" | "statusChangedAt" | "version"
  >,
  replayed: boolean,
): EnquiryRecorded => ({
  id: row.id,
  locationId: row.locationId,
  status: row.status,
  statusChangedAt: row.statusChangedAt.toISOString(),
  version: row.version,
  replayed,
});

export const peopleEnquiriesRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people",
      tags: ["people"],
      summary: "Record an enquiry: a new person record at enquiry (people.md rule 1)",
      description:
        "people.enquiry.manage at the location the enquiry is about. Names and a date of birth (1900 to today) only; the assessment starts with POST /v1/people/{id}/status (to pre_admission). The time it came in may be earlier than now, never later, before 1900 or before the birth. The answer is the record's id and state, never the person's details. A request sent again by the same person with the same id and details answers as the first (replayed); the same id with other details is refused with 409 `id_reused_with_different_details`; an id in use for anything else is refused (422). Refusals are audited with opaque ids.",
      security,
      request: { body: { content: { "application/json": { schema: CreateEnquiry } } } },
      responses: {
        201: jsonBody(
          EnquiryRecorded,
          "Recorded (or the first copy of the same request sent again)",
        ),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "people.enquiry.manage");
      const body = c.req.valid("json");
      const now = new Date();
      const receivedAt = body.receivedAt ? new Date(body.receivedAt) : now;
      if (receivedAt.getTime() > now.getTime()) {
        throw problems.invalid("The enquiry cannot have come in later than now.");
      }
      // Checked again here, in the UK calendar, whatever the contract allowed when it was read.
      if (body.dateOfBirth > ukIsoDate(now)) {
        throw problems.invalid("The date of birth cannot be in the future.");
      }
      const givenName = body.givenName.trim();
      const familyName = body.familyName.trim();
      const preferredName = body.preferredName?.trim() || null;
      // Outside the caller's locations reads as not found (HZ-011), and is audited.
      try {
        requireLocationInScope(access, body.locationId);
      } catch (error) {
        if (!(error instanceof HttpProblem)) throw error;
        await refuseOutside(c, access, error, body.locationId, "outside_scope");
      }
      const result = await withAuditedRefusal(c, access, () =>
        withTenant(c, async (tx) => {
          const [loc] = await tx
            .select({ id: location.id })
            .from(location)
            .where(eq(location.id, body.locationId));
          if (!loc) {
            throw new AuditedRefusal(problems.notFound(), {
              action: ACTION,
              outcome: "denied",
              resourceType: "location",
              resourceId: body.locationId,
              reason: "location_not_found",
            });
          }
          // One path whatever the id: the insert, which does nothing when the id is in use, then
          // a read of what holds it. An id the caller cannot see, and someone else's record they
          // can, take the same steps and get the same answer (#118 review, L2).
          const [created] = await tx
            .insert(person)
            .values({
              ...(body.id ? { id: body.id } : {}),
              locationId: body.locationId,
              status: "enquiry",
              givenName,
              familyName,
              preferredName,
              dateOfBirth: body.dateOfBirth,
              statusChangedAt: receivedAt,
            })
            .onConflictDoNothing({ target: person.id })
            .returning({
              id: person.id,
              locationId: person.locationId,
              status: person.status,
              statusChangedAt: person.statusChangedAt,
              version: person.version,
            })
            .catch((error: unknown): never => {
              const e = error as { message?: string; cause?: { message?: string } };
              const message = e.cause?.message ?? e.message ?? "";
              // The same status as an id in use, so sample mode tells a prober nothing more.
              if (SAMPLE_REFUSALS.has(message)) {
                throw new HttpProblem(
                  422,
                  "remove_sample_data_first",
                  "Remove the sample data before recording real people.",
                );
              }
              const code = dbCode(error);
              // A race with another insert of the same id: refused like any id in use.
              if (code === "23505" && body.id) {
                throw idRefusal(problems.invalid(ID_IN_USE), body.id, "id_in_use");
              }
              // A value Postgres cannot hold (class 22, data exception): the request's fault.
              if (code?.startsWith("22")) throw problems.invalid("Check the dates and names.");
              throw error;
            });
          if (created) {
            await audit(c, tx, access, {
              action: ACTION,
              resourceType: "person",
              resourceId: created.id,
              scope: { locationId: body.locationId, backdated: body.receivedAt !== undefined },
            });
            return answer(created, false);
          }
          // Nothing inserted: the id is in use (an insert without an id never conflicts).
          const id = body.id ?? "";
          const [stored] = await tx
            .select({
              id: person.id,
              locationId: person.locationId,
              status: person.status,
              createdBy: person.createdBy,
              givenName: person.givenName,
              familyName: person.familyName,
              preferredName: person.preferredName,
              dateOfBirth: person.dateOfBirth,
              statusChangedAt: person.statusChangedAt,
              version: person.version,
            })
            .from(person)
            .where(eq(person.id, id));
          // Only the caller's own enquiry is ever answered as a request sent again: a record they
          // cannot see, anyone else's, or one that has moved on, is refused without a word about it.
          const own =
            stored !== undefined &&
            stored.status === "enquiry" &&
            stored.createdBy === access.tenantUserId &&
            stored.locationId === body.locationId;
          if (!stored || !own) throw idRefusal(problems.invalid(ID_IN_USE), id, "id_in_use");
          const same =
            stored.givenName === givenName &&
            stored.familyName === familyName &&
            (stored.preferredName ?? null) === preferredName &&
            stored.dateOfBirth === body.dateOfBirth &&
            (body.receivedAt === undefined ||
              stored.statusChangedAt.getTime() === receivedAt.getTime());
          if (!same) {
            throw idRefusal(
              new HttpProblem(
                409,
                "id_reused_with_different_details",
                "An enquiry was already saved with this id and other details.",
                "Nothing was changed. Check the enquiries list before recording it again, so the person has one record.",
              ),
              stored.id,
              "id_reused_with_different_details",
            );
          }
          await audit(c, tx, access, {
            action: `${ACTION}.replay`,
            resourceType: "person",
            resourceId: stored.id,
          });
          return answer(stored, true);
        }),
      );
      return c.json(result, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/services",
      tags: ["people"],
      summary: "The services run at a location, for an assessment or an admission",
      description:
        "Organisation configuration, no personal data. For holders of people.enquiry.manage, people.admission.manage or people.person.read who work at the location; anywhere else reads as not found.",
      security,
      request: { params: LocationParam },
      responses: {
        200: jsonBody(ServiceList, "Services, by name"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [
        "people.enquiry.manage",
        "people.admission.manage",
        "people.person.read",
      ]);
      const { id } = c.req.valid("param");
      requireLocationInScope(access, id);
      const items = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(service)
          .where(and(eq(service.locationId, id), isNull(service.deletedAt)))
          .orderBy(asc(service.name));
        return rows.map((row) => ({
          id: row.id,
          locationId: row.locationId,
          name: row.name,
          serviceType: row.serviceType,
          status: row.status,
        }));
      });
      return c.json({ items }, 200);
    },
  );
