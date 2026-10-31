import {
  AgencyBookingItem,
  AgencyConfirmationBody,
  AgencyCostList,
  AgencyFeedbackItem,
  AgencyFeedbackList,
  AgencyItem,
  AgencyList,
  AgencyWorkerItem,
  AgencyWorkerList,
  ArchiveAgency,
  AwrClockItem,
  BookShift,
  CancelBooking,
  CreateAgency,
  InductionItem,
  RecordAgencyFeedback,
  RecordInduction,
  RegisterAgencyWorker,
} from "@harbour/contracts";
import {
  agency,
  agencyBooking,
  agencyWorker,
  agencyWorkerFeedback,
  locationInduction,
  rosterOverride,
  shift,
  shiftAssignment,
  type Transaction,
  task,
} from "@harbour/db";
import {
  awrClock,
  awrWeeksFromShifts,
  blockerKey,
  bookingCostPence,
  overrideCovers,
  PAY_RATE_KEYS,
  resolvePayRates,
  ukEndOfDay,
  ukIsoDate,
  ukStartOfDay,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { requireAnyPermission, requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { publish } from "../outbox";
import { rateRows } from "../services/rates";
import { blockerItems, shiftEligibility } from "../services/rota";
import { staffNames } from "../services/staff";
import { withSystemRights } from "../services/system-rights";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { audit, requireLocationInScope } from "./people-shared";
import {
  change,
  doubleBooked,
  loadShift,
  lockRota,
  lockWorker,
  markChanged,
  stale,
  stateConflict,
  worksAt,
} from "./rota";

/**
 * Bank and agency workers (scheduling.md section 15; SCHED-009; ADR-0088; hazards HZ-124 and
 * HZ-011). Booking an open shift applies the rostering rule as assigning does (the agency's
 * confirmation stands in for the staff file for agency workers) and opens the worker's access
 * window; cancelling closes it. Audit events carry opaque ids only, never a confirmation's detail,
 * notes or a reason.
 */

const READERS = ["scheduling.rota.manage", "scheduling.rota.read"] as const;
/** Who a safeguarding concern about a worker goes to (the organisation may give the role to anyone). */
export const SAFEGUARDING_CONCERN_ROLE = "registered_manager";
const A = {
  agencyCreated: "scheduling.agency.created",
  agencyArchived: "scheduling.agency.archived",
  registered: "scheduling.agency_worker.registered",
  confirmed: "scheduling.agency_worker.confirmed",
  booked: "scheduling.agency_booking.made",
  cancelled: "scheduling.agency_booking.cancelled",
  overridden: "scheduling.roster_override.given",
  induction: "scheduling.induction.recorded",
  feedback: "scheduling.agency_feedback.recorded",
  awr: "scheduling.awr.viewed",
} as const;

const IdParam = z.object({ id: z.uuid() });
type AgencyRow = typeof agency.$inferSelect;
type WorkerRow = typeof agencyWorker.$inferSelect;
type BookingRow = typeof agencyBooking.$inferSelect;

const agencyItem = (r: AgencyRow): z.infer<typeof AgencyItem> => ({
  id: r.id,
  version: r.version,
  name: r.name,
  contactEmail: r.contactEmail,
  frameworkRef: r.frameworkRef,
  defaultChargePencePerHour: r.defaultChargePencePerHour,
  archived: r.deletedAt !== null,
});

function workerItem(
  w: WorkerRow,
  names: Awaited<ReturnType<typeof staffNames>>,
  bookingsCancelled = 0,
): z.infer<typeof AgencyWorkerItem> {
  return {
    id: w.id,
    version: w.version,
    member: names(w.tenantUserId) ?? {
      id: w.tenantUserId,
      displayName: "Member of staff",
      jobTitle: null,
    },
    kind: w.kind as "agency" | "bank",
    agencyId: w.agencyId,
    roleTitle: w.roleTitle,
    confirmation:
      w.kind === "agency"
        ? {
            dbsConfirmedOn: w.dbsConfirmedOn,
            dbsEnhancedBarred: w.dbsEnhancedBarred,
            rightToWorkConfirmedOn: w.rightToWorkConfirmedOn,
            rightToWorkExpiresOn: w.rightToWorkExpiresOn,
            registrationBody: w.registrationBody,
            registrationValidUntil: w.registrationValidUntil,
            confirmedBy: w.confirmedBy,
          }
        : null,
    doNotBook: w.doNotBook,
    bookingsCancelled,
  };
}

const bookingItem = (
  b: BookingRow,
  inductionDue: boolean,
  concernsRecorded = 0,
): z.infer<typeof AgencyBookingItem> => ({
  id: b.id,
  version: b.version,
  shiftId: b.shiftId,
  assignmentId: b.assignmentId,
  locationId: b.locationId,
  workerId: b.workerId,
  agencyId: b.agencyId,
  kind: b.kind as "agency" | "bank",
  bookingRef: b.bookingRef,
  chargePencePerHour: b.chargePencePerHour,
  costPence: b.costPence,
  status: b.status as "confirmed" | "cancelled",
  inductionDue,
  concernsRecorded,
});

async function loadWorker(tx: Transaction, id: string): Promise<WorkerRow | null> {
  const [row] = await tx.select().from(agencyWorker).where(eq(agencyWorker.id, id));
  return row ?? null;
}

/** Whether the worker has an induction recorded at the location (rule 5). */
async function inducted(tx: Transaction, workerId: string, locationId: string) {
  const rows = await tx
    .select({ id: locationInduction.id })
    .from(locationInduction)
    .where(
      and(eq(locationInduction.workerId, workerId), eq(locationInduction.locationId, locationId)),
    )
    .limit(1);
  return rows.length > 0;
}

/** Concerns recorded about a worker at any location: the count only (clinical review H5). */
async function concernsAbout(tx: Transaction, workerId: string): Promise<number> {
  const rows = await withSystemRights(tx, () =>
    tx
      .select({ id: agencyWorkerFeedback.id })
      .from(agencyWorkerFeedback)
      .where(
        and(
          eq(agencyWorkerFeedback.workerId, workerId),
          inArray(agencyWorkerFeedback.kind, ["concern", "do_not_rebook"]),
        ),
      ),
  );
  return rows.length;
}

/**
 * After a worker's standing changes (do not book, a new confirmation), every booking of theirs not
 * yet over is checked again with the rostering rule; one the rule now blocks, with no override
 * covering it, is cancelled, which takes them off the shift and closes their access (clinical
 * safety review of slice 27, H1). Read and cancelled at every location with the system's rights:
 * the caller's own scope must not leave a booking standing elsewhere.
 */
async function recheckBookings(
  tx: Transaction,
  tenantId: string,
  memberId: string,
  reason: string,
): Promise<number> {
  const now = new Date();
  const live = await withSystemRights(tx, () =>
    tx
      .select({ booking: agencyBooking, shiftRow: shift })
      .from(agencyBooking)
      .innerJoin(shift, eq(shift.id, agencyBooking.shiftId))
      .where(
        and(
          eq(agencyBooking.workerId, memberId),
          eq(agencyBooking.status, "confirmed"),
          isNull(shift.deletedAt),
          gt(shift.endsAt, now),
        ),
      ),
  );
  let cancelled = 0;
  for (const { booking, shiftRow } of live) {
    const decision = await shiftEligibility(tx, tenantId, shiftRow, memberId, null, now);
    if (decision.allowed) continue;
    const overridden = await withSystemRights(tx, () =>
      tx
        .select({ keys: rosterOverride.blockerKeys })
        .from(rosterOverride)
        .where(eq(rosterOverride.assignmentId, booking.assignmentId)),
    );
    if (
      overrideCovers(
        overridden.flatMap((o) => o.keys),
        decision.blockers,
      )
    )
      continue;
    await withSystemRights(tx, () =>
      tx
        .update(shiftAssignment)
        .set({ deletedAt: now, removeReason: reason })
        .where(
          and(eq(shiftAssignment.id, booking.assignmentId), isNull(shiftAssignment.deletedAt)),
        ),
    );
    cancelled++;
  }
  return cancelled;
}

export const agencyRouter = createRouter()
  // ----------------------------------------------------------------------------------------
  // Agencies
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/agencies",
      tags: ["scheduling"],
      summary: "Agencies",
      security,
      responses: { 200: jsonBody(AgencyList, "Agencies"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const rows = await withTenant(c, (tx) => tx.select().from(agency).orderBy(asc(agency.name)));
      return c.json({ items: rows.map(agencyItem) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/agencies",
      tags: ["scheduling"],
      summary: "Add an agency",
      security,
      request: { body: jsonBody(CreateAgency, "The agency") },
      responses: { 201: jsonBody(AgencyItem, "Added"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const body = c.req.valid("json");
      const row = await change(
        c,
        access,
        { action: A.agencyCreated, resourceType: "agency", id: null },
        async (tx) => {
          const [made] = await tx.insert(agency).values(body).returning();
          if (!made) throw new Error("agency not stored");
          await audit(c, tx, access, {
            action: A.agencyCreated,
            resourceType: "agency",
            resourceId: made.id,
          });
          return made;
        },
      );
      return c.json(agencyItem(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/agencies/{id}/archive",
      tags: ["scheduling"],
      summary: "Archive an agency",
      description: "Existing bookings stay; no new ones.",
      security,
      request: { params: IdParam, body: jsonBody(ArchiveAgency, "Against version, with why") },
      responses: {
        200: jsonBody(AgencyItem, "Archived"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const row = await change(
        c,
        access,
        { action: A.agencyArchived, resourceType: "agency", id },
        async (tx) => {
          const [done] = await tx
            .update(agency)
            .set({ deletedAt: new Date(), archiveReason: body.reason })
            .where(
              and(eq(agency.id, id), eq(agency.version, body.version), isNull(agency.deletedAt)),
            )
            .returning();
          if (!done) {
            const [exists] = await tx
              .select({ id: agency.id })
              .from(agency)
              .where(eq(agency.id, id));
            if (!exists) return null;
            throw stale();
          }
          await audit(c, tx, access, {
            action: A.agencyArchived,
            resourceType: "agency",
            resourceId: id,
          });
          return done;
        },
      );
      if (!row) throw problems.notFound();
      return c.json(agencyItem(row), 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // Workers
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/agency-workers",
      tags: ["scheduling"],
      summary: "Bank and agency workers",
      security,
      responses: { 200: jsonBody(AgencyWorkerList, "Workers"), ...errorResponses },
    }),
    async (c) => {
      // The agency's confirmation and do-not-book are for rota builders only (security review M3).
      await requirePermission(c, "scheduling.rota.manage");
      const items = await withTenant(c, async (tx) => {
        const rows = await tx.select().from(agencyWorker).orderBy(asc(agencyWorker.createdAt));
        const names = await staffNames(
          tx,
          rows.map((r) => r.tenantUserId),
        );
        return rows.map((r) => workerItem(r, names));
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/agency-workers",
      tags: ["scheduling"],
      summary: "Register a bank or agency worker",
      description:
        "A member who holds no role but agency_worker. Registering flags them as agency or bank: from then their access comes only from booked shifts (ADR-0088).",
      security,
      request: { body: jsonBody(RegisterAgencyWorker, "The worker") },
      responses: {
        201: jsonBody(AgencyWorkerItem, "Registered"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, "scheduling.rota.manage");
      // Registering changes what the member may ever hold (ADR-0088): member management too.
      const access = await requirePermission(c, "platform.user.manage");
      const body = c.req.valid("json");
      if ((body.kind === "agency") !== (body.agencyId !== null)) {
        throw problems.invalid("An agency worker names their agency; a bank worker names none.");
      }
      if (body.tenantUserId === access.tenantUserId) {
        throw new HttpProblem(
          403,
          "separation_of_duties",
          "Someone else must register you as a bank or agency worker.",
        );
      }
      const item = await change(
        c,
        access,
        { action: A.registered, resourceType: "tenant_user", id: body.tenantUserId },
        async (tx) => {
          if (body.agencyId) {
            const [a] = await tx.select().from(agency).where(eq(agency.id, body.agencyId));
            if (!a || a.deletedAt) throw problems.invalid("That agency is not a live agency.");
          }
          const [made] = await tx.insert(agencyWorker).values(body).returning();
          if (!made) throw new Error("worker not stored");
          await audit(c, tx, access, {
            action: A.registered,
            resourceType: "agency_worker",
            resourceId: made.id,
            scopeExtra: { tenantUserId: body.tenantUserId, kind: body.kind },
          });
          return workerItem(made, await staffNames(tx, [made.tenantUserId]));
        },
      );
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/agency-workers/{id}/confirmation",
      tags: ["scheduling"],
      summary: "Record the agency's confirmation of a worker's checks",
      description:
        "From the agency's written confirmation (DBS, right to work, registration), recorded in the recorder's own name, never by the worker. Agency workers only: a bank worker's checks are in their staff file.",
      security,
      request: { params: IdParam, body: jsonBody(AgencyConfirmationBody, "Against version") },
      responses: {
        200: jsonBody(AgencyWorkerItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const { version, ...body } = c.req.valid("json");
      const today = ukIsoDate(new Date());
      if (
        (body.dbsConfirmedOn && body.dbsConfirmedOn > today) ||
        (body.rightToWorkConfirmedOn && body.rightToWorkConfirmedOn > today)
      ) {
        throw problems.invalid(
          "A confirmation is of checks already made: date it today or earlier.",
        );
      }
      const item = await change(
        c,
        access,
        { action: A.confirmed, resourceType: "agency_worker", id },
        async (tx) => {
          const w = await loadWorker(tx, id);
          if (!w) return null;
          if (w.kind !== "agency") {
            throw problems.invalid("A bank worker's checks are in their staff file.");
          }
          const [done] = await tx
            .update(agencyWorker)
            .set({ ...body, confirmedBy: access.tenantUserId })
            .where(and(eq(agencyWorker.id, id), eq(agencyWorker.version, version)))
            .returning();
          if (!done) throw stale();
          const bookingsCancelled = await recheckBookings(
            tx,
            access.tenantId,
            done.tenantUserId,
            "The agency's confirmation changed",
          );
          await audit(c, tx, access, {
            action: A.confirmed,
            resourceType: "agency_worker",
            resourceId: id,
            scopeExtra: { bookingsCancelled },
          });
          return workerItem(done, await staffNames(tx, [done.tenantUserId]), bookingsCancelled);
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // Booking (HZ-124; ADR-0088)
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/shifts/{id}/booking",
      tags: ["scheduling"],
      summary: "Book a bank or agency worker onto an open shift",
      description:
        "Applies the rostering rule as assigning does (the agency's confirmation for agency workers, the staff file for bank workers, the competence port, every UK date the shift touches); an override needs scheduling.rota.approve and the blocker keys shown. Never for a right to work, a member not active or one marked do not book. Records the cost and opens the worker's access window for the shift (ADR-0088).",
      security,
      request: { params: IdParam, body: jsonBody(BookShift, "Who, against the shift's version") },
      responses: {
        201: jsonBody(AgencyBookingItem, "Booked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      let access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.override) access = await requirePermission(c, "scheduling.rota.approve");
      const result = await change(
        c,
        access,
        { action: A.booked, resourceType: "shift", id },
        async (tx) => {
          const found = await loadShift(tx, id);
          if (!found) return null;
          requireLocationInScope(access, found.locationId);
          const locked = await lockRota(tx, found.rotaId);
          const s = await loadShift(tx, id, true);
          if (!s || !locked) return null;
          if (s.version !== body.version) throw stale();
          const [taken] = await tx
            .select({ id: shiftAssignment.id })
            .from(shiftAssignment)
            .where(and(eq(shiftAssignment.shiftId, s.id), isNull(shiftAssignment.deletedAt)));
          if (taken) throw stateConflict("This shift is not open: someone is already on it.");
          const [w] = await tx
            .select()
            .from(agencyWorker)
            .where(eq(agencyWorker.tenantUserId, body.workerId));
          if (!w || !(await worksAt(tx, body.workerId, s.locationId))) return null;
          if (w.doNotBook) {
            return {
              refused: new HttpProblem(
                422,
                "do_not_book",
                "This worker is marked not to be booked again.",
              ),
            };
          }
          let charge = body.chargePencePerHour;
          if (w.agencyId) {
            const [a] = await tx.select().from(agency).where(eq(agency.id, w.agencyId));
            if (!a || a.deletedAt)
              throw problems.invalid("That worker's agency has been archived.");
            charge ??= a.defaultChargePencePerHour ?? undefined;
          }
          if (charge === undefined) {
            throw problems.invalid("Give the charge per hour for this booking.");
          }
          const now = new Date();
          const decision = await shiftEligibility(
            tx,
            access.tenantId,
            s,
            body.workerId,
            body.override ?? null,
            now,
          );
          if (!decision.allowed) {
            const words = decision.blockers
              .map((b) => blockerItems([b])[0]?.message)
              .filter(Boolean)
              .join(" ");
            const code =
              decision.overrideRefused === "blockers_changed"
                ? "blockers_changed"
                : decision.blockers.some((b) => b.kind === "right_to_work")
                  ? "right_to_work"
                  : decision.blockers.some((b) => b.kind === "not_active")
                    ? "not_active"
                    : "not_eligible";
            await audit(c, tx, access, {
              action: A.booked,
              outcome: "denied",
              resourceType: "shift",
              resourceId: id,
              reason: code,
              scopeExtra: { workerId: body.workerId },
            });
            return {
              refused: new HttpProblem(
                code === "blockers_changed" ? 409 : 422,
                code,
                code === "blockers_changed"
                  ? "What stops this worker working the shift has changed since you looked. Check it again before overriding."
                  : code === "not_eligible"
                    ? "This worker cannot be booked onto this shift without a manager's override."
                    : "This worker cannot be booked onto this shift. This cannot be overridden.",
                words,
              ),
            };
          }
          await lockWorker(tx, access.tenantId, body.workerId);
          if (await doubleBooked(tx, body.workerId, s)) {
            throw stateConflict("This worker is already on a shift at that time.");
          }
          const [assignment] = await tx
            .insert(shiftAssignment)
            .values({ shiftId: s.id, locationId: s.locationId, workerId: body.workerId })
            .returning();
          if (!assignment) throw new Error("assignment not stored");
          if (decision.overridden.length > 0 && body.override) {
            await tx.insert(rosterOverride).values({
              assignmentId: assignment.id,
              locationId: s.locationId,
              workerId: body.workerId,
              blockerKeys: decision.overridden.map(blockerKey),
              justification: body.override.justification,
            });
            await audit(c, tx, access, {
              action: A.overridden,
              resourceType: "shift_assignment",
              resourceId: assignment.id,
              scopeExtra: { workerId: body.workerId, blockers: decision.overridden.length },
            });
          }
          const [booking] = await tx
            .insert(agencyBooking)
            .values({
              shiftId: s.id,
              assignmentId: assignment.id,
              locationId: s.locationId,
              workerId: body.workerId,
              agencyId: w.agencyId,
              kind: w.kind,
              bookingRef: body.bookingRef,
              chargePencePerHour: charge,
              costPence: bookingCostPence(s.startsAt, s.endsAt, s.breakMinutes, charge),
            })
            .returning();
          if (!booking) throw new Error("booking not stored");
          await markChanged(tx, s, locked, now);
          await audit(c, tx, access, {
            action: A.booked,
            resourceType: "agency_booking",
            resourceId: booking.id,
            scopeExtra: { shiftId: s.id, workerId: body.workerId, agencyId: w.agencyId },
          });
          await publish(tx, {
            context: "scheduling",
            aggregateType: "agency_booking",
            aggregateId: booking.id,
            type: "scheduling.agency_booking_made",
            payload: { bookingId: booking.id, shiftId: s.id, locationId: s.locationId },
          });
          return {
            item: bookingItem(
              booking,
              !(await inducted(tx, body.workerId, s.locationId)),
              await concernsAbout(tx, body.workerId),
            ),
          };
        },
      );
      if (!result) throw problems.notFound();
      if ("refused" in result) throw result.refused;
      return c.json(result.item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/agency-bookings/{id}/cancel",
      tags: ["scheduling"],
      summary: "Cancel a booking",
      description:
        "With a reason: the worker comes off the shift, which is open again, and their access window for it closes at once (ADR-0088). Recorded for notice once published.",
      security,
      request: { params: IdParam, body: jsonBody(CancelBooking, "Against version, with why") },
      responses: {
        200: jsonBody(AgencyBookingItem, "Cancelled"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(
        c,
        access,
        { action: A.cancelled, resourceType: "agency_booking", id },
        async (tx) => {
          const [b] = await tx.select().from(agencyBooking).where(eq(agencyBooking.id, id));
          if (!b) return null;
          requireLocationInScope(access, b.locationId);
          if (b.status === "cancelled") throw stateConflict("This booking is already cancelled.");
          const s = await loadShift(tx, b.shiftId);
          if (s && s.endsAt <= new Date()) {
            // A worked booking stays: its cost and AWR week stand (security review L4).
            throw stateConflict("This shift is over: a worked booking cannot be cancelled.");
          }
          const locked = s ? await lockRota(tx, s.rotaId) : null;
          const now = new Date();
          const [done] = await tx
            .update(agencyBooking)
            .set({ status: "cancelled", cancelledAt: now, cancelReason: body.reason })
            .where(and(eq(agencyBooking.id, id), eq(agencyBooking.version, body.version)))
            .returning();
          if (!done) throw stale();
          await tx
            .update(shiftAssignment)
            .set({ deletedAt: now, removeReason: body.reason })
            .where(and(eq(shiftAssignment.id, b.assignmentId), isNull(shiftAssignment.deletedAt)));
          if (s && locked) await markChanged(tx, s, locked, now);
          await audit(c, tx, access, {
            action: A.cancelled,
            resourceType: "agency_booking",
            resourceId: id,
          });
          await publish(tx, {
            context: "scheduling",
            aggregateType: "agency_booking",
            aggregateId: id,
            type: "scheduling.agency_booking_cancelled",
            payload: { bookingId: id, shiftId: b.shiftId, locationId: b.locationId },
          });
          return bookingItem(done, false);
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 200);
    },
  )
  // ----------------------------------------------------------------------------------------
  // AWR, induction, feedback, cost
  // ----------------------------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/agency-workers/{id}/awr",
      tags: ["scheduling"],
      summary: "An agency worker's AWR clock",
      description:
        "Agency Workers Regulations 2010 reg 7, from the worker's confirmed bookings with this organisation at every location: the weeks counted and the week equal basic terms apply from. Weeks with no booking between bookings have no recorded reason and are treated as uncovered (H-924).",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(AwrClockItem, "The clock"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const item = await withTenant(c, async (tx) => {
        const w = await loadWorker(tx, id);
        if (!w) return null;
        if (w.kind !== "agency") return "bank" as const;
        // Every location's bookings count with one hirer; read with the system's rights, and only
        // the weeks leave here.
        const starts = await withSystemRights(tx, () =>
          tx
            .select({ startsAt: shift.startsAt })
            .from(agencyBooking)
            .innerJoin(shift, eq(shift.id, agencyBooking.shiftId))
            .innerJoin(shiftAssignment, eq(shiftAssignment.id, agencyBooking.assignmentId))
            .where(
              and(
                eq(agencyBooking.workerId, w.tenantUserId),
                eq(agencyBooking.status, "confirmed"),
                isNull(shift.deletedAt),
                isNull(shiftAssignment.deletedAt),
                lte(shift.startsAt, new Date()),
              ),
            ),
        );
        const today = ukIsoDate(new Date());
        const rates = resolvePayRates(
          await rateRows(tx, Object.values(PAY_RATE_KEYS)),
          "england",
          today,
          access.tenantId,
        );
        const weeks = awrWeeksFromShifts(
          starts.map((r) => r.startsAt),
          today,
        );
        const clock = awrClock(weeks, rates);
        await audit(c, tx, access, {
          action: A.awr,
          resourceType: "agency_worker",
          resourceId: id,
        });
        return {
          workerId: w.tenantUserId,
          qualifyingWeeks: clock.qualifyingWeeks,
          qualifyingWeeksNeeded: rates.awrQualifyingWeeks,
          qualifiedFromWeek: clock.qualifiedFromWeek,
          weeksWithoutReason: weeks.filter((x) => x.kind === "break").length,
          resets: clock.resets.map((r) => ({ ...r })),
          method: [
            "Weeks run for seven days from the day of the first booked shift (regulation 7(4)); a week with a shift that has started counts as worked. Future bookings do not count.",
            "Weeks with no booking between bookings are breaks with no reason recorded, so the clock treats them as uncovered; record the reason where one applies.",
            `Equal basic terms apply after ${rates.awrQualifyingWeeks} qualifying weeks (Agency Workers Regulations 2010, regulation 7).`,
          ],
        };
      });
      if (!item) throw problems.notFound();
      if (item === "bank")
        throw problems.invalid("Bank workers are the organisation's own staff: no AWR clock.");
      return c.json(item, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/agency-workers/{id}/inductions",
      tags: ["scheduling"],
      summary: "Record an induction at a location",
      description:
        "By a member who is not the worker, with the location's checklist items covered.",
      security,
      request: { params: IdParam, body: jsonBody(RecordInduction, "The induction") },
      responses: {
        201: jsonBody(InductionItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      requireLocationInScope(access, body.locationId);
      if (body.inductedOn > ukIsoDate(new Date())) {
        throw problems.invalid("An induction is recorded on or after the day it happened.");
      }
      const item = await change(
        c,
        access,
        { action: A.induction, resourceType: "agency_worker", id },
        async (tx) => {
          const w = await loadWorker(tx, id);
          if (!w) return null;
          if (w.tenantUserId === access.tenantUserId) {
            throw new HttpProblem(403, "separation_of_duties", "Someone else must induct you.");
          }
          const [made] = await tx
            .insert(locationInduction)
            .values({
              workerId: w.tenantUserId,
              locationId: body.locationId,
              inductedOn: body.inductedOn,
              items: [...new Set(body.items)],
            })
            .returning();
          if (!made) throw new Error("induction not stored");
          await audit(c, tx, access, {
            action: A.induction,
            resourceType: "location_induction",
            resourceId: made.id,
            scopeExtra: { workerId: w.tenantUserId, locationId: body.locationId },
          });
          return {
            id: made.id,
            workerId: made.workerId,
            locationId: made.locationId,
            inductedOn: made.inductedOn,
            items: made.items,
            inductedBy: made.createdBy,
          };
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/agency-workers/{id}/feedback",
      tags: ["scheduling"],
      summary: "Feedback on a worker",
      description: "Only where the reader builds the rota; newest first.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(AgencyFeedbackList, "Feedback"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const items = await withTenant(c, async (tx) => {
        const w = await loadWorker(tx, id);
        if (!w) return null;
        const rows = await tx
          .select()
          .from(agencyWorkerFeedback)
          .where(eq(agencyWorkerFeedback.workerId, w.tenantUserId))
          .orderBy(desc(agencyWorkerFeedback.createdAt));
        return rows.map(feedbackItem);
      });
      if (!items) throw problems.notFound();
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/agency-workers/{id}/feedback",
      tags: ["scheduling"],
      summary: "Record feedback after a booking",
      description:
        "Positive, a concern, or do not rebook (which marks the worker not to be booked again). Never by the worker about themselves.",
      security,
      request: { params: IdParam, body: jsonBody(RecordAgencyFeedback, "The feedback") },
      responses: {
        201: jsonBody(AgencyFeedbackItem, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const item = await change(
        c,
        access,
        { action: A.feedback, resourceType: "agency_worker", id },
        async (tx) => {
          const w = await loadWorker(tx, id);
          if (!w) return null;
          const [b] = await tx
            .select()
            .from(agencyBooking)
            .where(
              and(eq(agencyBooking.id, body.bookingId), eq(agencyBooking.workerId, w.tenantUserId)),
            );
          if (!b) throw problems.invalid("That booking is not this worker's.");
          requireLocationInScope(access, b.locationId);
          const [made] = await tx
            .insert(agencyWorkerFeedback)
            .values({
              workerId: w.tenantUserId,
              bookingId: b.id,
              locationId: b.locationId,
              kind: body.kind,
              notes: body.notes,
            })
            .returning();
          if (!made) throw new Error("feedback not stored");
          let bookingsCancelled = 0;
          if (body.kind === "do_not_rebook" && !w.doNotBook) {
            await tx
              .update(agencyWorker)
              .set({ doNotBook: true, doNotBookReason: "Feedback after a booking: do not rebook" })
              .where(eq(agencyWorker.id, w.id));
            bookingsCancelled = await recheckBookings(
              tx,
              access.tenantId,
              w.tenantUserId,
              "Marked not to be booked again",
            );
          }
          // A safeguarding concern is never left in feedback (clinical safety review H5): an urgent
          // task for the Registered Manager at the location to raise it as an incident.
          if (body.safeguarding) {
            await tx.insert(task).values({
              kind: "scheduling.agency_safeguarding_concern",
              title: "Raise a safeguarding concern about a bank or agency worker",
              requiredPermission: "safety.incident.report",
              locationId: b.locationId,
              sourceType: "agency_worker_feedback",
              sourceId: made.id,
              assigneeRoleKey: SAFEGUARDING_CONCERN_ROLE,
              dueAt: new Date(),
              priority: "urgent",
            });
            await publish(tx, {
              context: "scheduling",
              aggregateType: "agency_worker_feedback",
              aggregateId: made.id,
              type: "scheduling.agency_safeguarding_concern_raised",
              payload: { feedbackId: made.id, workerId: w.tenantUserId, locationId: b.locationId },
            });
          }
          await audit(c, tx, access, {
            action: A.feedback,
            resourceType: "agency_worker_feedback",
            resourceId: made.id,
            scopeExtra: {
              workerId: w.tenantUserId,
              kind: body.kind,
              safeguarding: body.safeguarding ?? false,
              bookingsCancelled,
            },
          });
          return feedbackItem(made);
        },
      );
      if (!item) throw problems.notFound();
      return c.json(item, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/agency-costs",
      tags: ["scheduling"],
      summary: "Bank and agency cost at a location",
      description: "Confirmed bookings of shifts starting between two UK dates, per agency.",
      security,
      request: { params: IdParam, query: z.object({ from: z.iso.date(), to: z.iso.date() }) },
      responses: {
        200: jsonBody(AgencyCostList, "Cost"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "scheduling.rota.manage");
      const { id } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      requireLocationInScope(access, id);
      if (to < from) throw problems.invalid("The last date must not be before the first.");
      if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) {
        throw problems.invalid("Ask for at most 93 days at a time.");
      }
      const rows = await withTenant(c, (tx) =>
        tx
          .select({
            agencyId: agencyBooking.agencyId,
            kind: agencyBooking.kind,
            costPence: agencyBooking.costPence,
          })
          .from(agencyBooking)
          .innerJoin(shift, eq(shift.id, agencyBooking.shiftId))
          .where(
            and(
              eq(agencyBooking.locationId, id),
              eq(agencyBooking.status, "confirmed"),
              isNull(shift.deletedAt),
              gte(shift.startsAt, ukStartOfDay(from)),
              lt(shift.startsAt, ukEndOfDay(to)),
            ),
          ),
      );
      const totals = new Map<
        string,
        { agencyId: string | null; kind: "agency" | "bank"; bookings: number; costPence: number }
      >();
      for (const r of rows) {
        const key = `${r.kind}:${r.agencyId ?? ""}`;
        const t = totals.get(key) ?? {
          agencyId: r.agencyId,
          kind: r.kind as "agency" | "bank",
          bookings: 0,
          costPence: 0,
        };
        t.bookings++;
        t.costPence += r.costPence;
        totals.set(key, t);
      }
      const items = [...totals.values()];
      return c.json(
        {
          locationId: id,
          from,
          to,
          items,
          totalPence: items.reduce((n, t) => n + t.costPence, 0),
        },
        200,
      );
    },
  );

function feedbackItem(
  f: typeof agencyWorkerFeedback.$inferSelect,
): z.infer<typeof AgencyFeedbackItem> {
  return {
    id: f.id,
    workerId: f.workerId,
    bookingId: f.bookingId,
    locationId: f.locationId,
    kind: f.kind as "positive" | "concern" | "do_not_rebook",
    notes: f.notes,
    createdBy: f.createdBy,
    createdAt: f.createdAt.toISOString(),
  };
}
