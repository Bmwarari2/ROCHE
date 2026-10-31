import { CreateEnquiry, PersonSummary, ServiceList } from "@harbour/contracts";
import { location, person, service } from "@harbour/db";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull } from "drizzle-orm";
import { requireAnyPermission, requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { personSummaries } from "./people";
import { audit, dbCode, requireLocationInScope } from "./people-shared";

/**
 * Enquiries (people.md rule 1; the start of PEOP-004): a new person record at `enquiry`, so the
 * pre-admission assessment (rule 4) can start on its own record, and the services at a location
 * an assessment or an admission is for. An enquiry holds names and a date of birth only; the NHS
 * number and the rest follow on the record. A request sent again with its id returns the first
 * copy. Audited by record id.
 */

const LocationParam = z.object({ id: z.uuid() });

/** The sample-data guard (migration 0069) refuses a real person while sample people are loaded. */
const SAMPLE_REFUSALS = new Set(["remove_sample_data_first"]);

export const peopleEnquiriesRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people",
      tags: ["people"],
      summary: "Record an enquiry: a new person record at enquiry (people.md rule 1)",
      description:
        "people.enquiry.manage at the location the enquiry is about. Names and a date of birth only; the assessment starts with POST /v1/people/{id}/status (to pre_admission). The time it came in may be earlier than now, never later. A request sent again with the same id returns the first copy, audited as a view of it.",
      security,
      request: { body: { content: { "application/json": { schema: CreateEnquiry } } } },
      responses: {
        201: jsonBody(PersonSummary, "Recorded (or the earlier copy of a request sent again)"),
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
      if (body.dateOfBirth > now.toISOString().slice(0, 10)) {
        throw problems.invalid("The date of birth cannot be in the future.");
      }
      // Outside the caller's locations reads as not found (HZ-011).
      requireLocationInScope(access, body.locationId);
      const summary = await withTenant(c, async (tx) => {
        if (body.id) {
          const [replayed] = await tx
            .select({ id: person.id, locationId: person.locationId })
            .from(person)
            .where(eq(person.id, body.id));
          if (replayed) {
            if (replayed.locationId !== body.locationId) {
              throw problems.invalid("That id is already used.");
            }
            await audit(c, tx, access, {
              action: "people.person.view",
              resourceType: "person",
              resourceId: replayed.id,
              scope: { replay: true },
            });
            const [again] = await personSummaries(tx, [replayed.id]);
            if (!again) throw problems.invalid("That id is already used.");
            return again;
          }
        }
        const [loc] = await tx
          .select({ id: location.id })
          .from(location)
          .where(eq(location.id, body.locationId));
        if (!loc) throw problems.notFound();
        const [created] = await tx
          .insert(person)
          .values({
            ...(body.id ? { id: body.id } : {}),
            locationId: body.locationId,
            status: "enquiry",
            givenName: body.givenName.trim(),
            familyName: body.familyName.trim(),
            preferredName: body.preferredName?.trim() || null,
            dateOfBirth: body.dateOfBirth,
            statusChangedAt: receivedAt,
          })
          .returning({ id: person.id })
          .catch((error: unknown) => {
            const e = error as { message?: string; cause?: { message?: string } };
            const message = e.cause?.message ?? e.message ?? "";
            if (SAMPLE_REFUSALS.has(message)) {
              throw new HttpProblem(
                409,
                "remove_sample_data_first",
                "Remove the sample data before recording real people.",
              );
            }
            if (dbCode(error) === "23505") throw problems.invalid("That id is already used.");
            throw error;
          });
        if (!created) throw problems.conflict();
        await audit(c, tx, access, {
          action: "people.person.enquiry",
          resourceType: "person",
          resourceId: created.id,
          scope: { locationId: body.locationId, backdated: body.receivedAt !== undefined },
        });
        const [out] = await personSummaries(tx, [created.id]);
        if (!out) throw problems.conflict();
        return out;
      });
      return c.json(summary, 201);
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
