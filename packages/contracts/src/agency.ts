import { z } from "zod";

/**
 * Bank and agency workers (scheduling.md section 15; SCHED-009; ADR-0088; hazards HZ-124 and
 * HZ-011): agencies, workers with the agency's confirmation of their checks, bookings of open
 * shifts under the rostering rule, cost, the AWR clock, inductions at a location and feedback.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const pence = z.number().int().min(0).max(1_000_000);

export const AgencyWorkerKind = z.enum(["agency", "bank"]).meta({ id: "AgencyWorkerKind" });

export const CreateAgency = z
  .object({
    name: z.string().trim().min(1).max(120),
    contactEmail: z.email().max(200).nullable().default(null),
    frameworkRef: z.string().trim().max(80).nullable().default(null),
    defaultChargePencePerHour: z.number().int().min(1).max(1_000_000).nullable().default(null),
  })
  .meta({ id: "CreateAgency" });

export const AgencyItem = z
  .object({
    id: uuid,
    version,
    name: z.string(),
    contactEmail: z.string().nullable(),
    frameworkRef: z.string().nullable(),
    defaultChargePencePerHour: z.number().int().nullable(),
    archived: z.boolean(),
  })
  .meta({ id: "AgencyItem" });

export const AgencyList = z.object({ items: z.array(AgencyItem) }).meta({ id: "AgencyList" });

export const ArchiveAgency = z
  .object({ version, reason: z.string().trim().min(1).max(500) })
  .meta({ id: "ArchiveAgency" });

export const RegisterAgencyWorker = z
  .object({
    /** A member with no role but `agency_worker`; registering flags them as agency or bank. */
    tenantUserId: uuid,
    kind: AgencyWorkerKind,
    agencyId: uuid.nullable().default(null),
    roleTitle: z.string().trim().min(1).max(80),
  })
  .meta({ id: "RegisterAgencyWorker" });

export const AgencyConfirmationBody = z
  .object({
    version,
    dbsConfirmedOn: isoDate.nullable(),
    /** The agency confirmed an enhanced DBS with the adults' barred list. */
    dbsEnhancedBarred: z.boolean(),
    rightToWorkConfirmedOn: isoDate.nullable(),
    /** The last day of a time-limited right to work; null for an unlimited one. */
    rightToWorkExpiresOn: isoDate.nullable(),
    registrationBody: z.enum(["nmc", "hcpc", "swe", "gmc"]).nullable(),
    registrationValidUntil: isoDate.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      v.rightToWorkExpiresOn &&
      v.rightToWorkConfirmedOn &&
      v.rightToWorkExpiresOn < v.rightToWorkConfirmedOn
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["rightToWorkExpiresOn"],
        message: "The expiry is on or after the confirmation.",
      });
    }
    if ((v.registrationBody === null) !== (v.registrationValidUntil === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["registrationValidUntil"],
        message: "Give the register and how long the registration is valid together.",
      });
    }
  })
  .meta({ id: "AgencyConfirmation" });

export const AgencyWorkerItem = z
  .object({
    id: uuid,
    version,
    member: z.object({ id: uuid, displayName: z.string(), jobTitle: z.string().nullable() }),
    kind: AgencyWorkerKind,
    agencyId: uuid.nullable(),
    roleTitle: z.string(),
    confirmation: z
      .object({
        dbsConfirmedOn: isoDate.nullable(),
        dbsEnhancedBarred: z.boolean(),
        rightToWorkConfirmedOn: isoDate.nullable(),
        rightToWorkExpiresOn: isoDate.nullable(),
        registrationBody: z.string().nullable(),
        registrationValidUntil: isoDate.nullable(),
        confirmedBy: uuid.nullable(),
      })
      .nullable(),
    doNotBook: z.boolean(),
    /** Future bookings cancelled because the worker may no longer work them (this change only). */
    bookingsCancelled: z.number().int(),
  })
  .meta({ id: "AgencyWorkerItem" });

export const AgencyWorkerList = z
  .object({ items: z.array(AgencyWorkerItem) })
  .meta({ id: "AgencyWorkerList" });

export const BookShift = z
  .object({
    workerId: uuid,
    /** The shift's version, so a changed shift is not booked blind. */
    version,
    /** The agency's charge per hour; the agency's usual charge when left out. */
    chargePencePerHour: pence.optional(),
    bookingRef: z.string().trim().max(80).nullable().default(null),
    override: z
      .object({
        justification: z.string().trim().min(10).max(1000),
        blockerKeys: z.array(z.string().max(80)).min(1).max(20),
      })
      .optional(),
  })
  .meta({ id: "BookShift" });

export const AgencyBookingItem = z
  .object({
    id: uuid,
    version,
    shiftId: uuid,
    assignmentId: uuid,
    locationId: uuid,
    workerId: uuid,
    agencyId: uuid.nullable(),
    kind: AgencyWorkerKind,
    bookingRef: z.string().nullable(),
    chargePencePerHour: z.number().int(),
    costPence: z.number().int(),
    status: z.enum(["confirmed", "cancelled"]),
    /** No induction recorded at this location: induct them on arrival (H-922). */
    inductionDue: z.boolean(),
    /** Concerns recorded about this worker at any location (the count only, never the words). */
    concernsRecorded: z.number().int(),
  })
  .meta({ id: "AgencyBookingItem" });

export const CancelBooking = z
  .object({ version, reason: z.string().trim().min(1).max(500) })
  .meta({ id: "CancelBooking" });

export const AwrClockItem = z
  .object({
    workerId: uuid,
    qualifyingWeeks: z.number().int(),
    qualifyingWeeksNeeded: z.number().int(),
    /** The week equal basic terms apply from; null until qualified. */
    qualifiedFromWeek: isoDate.nullable(),
    /** Weeks with no booking between bookings: Harbour does not yet record why (H-924). */
    weeksWithoutReason: z.number().int(),
    resets: z.array(z.object({ week: isoDate, reason: z.enum(["break", "new_role"]) })),
    method: z.array(z.string()),
  })
  .meta({ id: "AwrClockItem" });

export const RecordInduction = z
  .object({
    locationId: uuid,
    inductedOn: isoDate,
    items: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-z][a-z0-9_]{1,59}$/),
      )
      .min(1)
      .max(40),
  })
  .meta({ id: "RecordInduction" });

export const InductionItem = z
  .object({
    id: uuid,
    workerId: uuid,
    locationId: uuid,
    inductedOn: isoDate,
    items: z.array(z.string()),
    inductedBy: uuid.nullable(),
  })
  .meta({ id: "InductionItem" });

export const RecordAgencyFeedback = z
  .object({
    bookingId: uuid,
    kind: z.enum(["positive", "concern", "do_not_rebook"]),
    notes: z.string().trim().min(1).max(2000),
    /**
     * Required for a concern or do not rebook: whether it is a safeguarding matter. If so, the
     * Registered Manager at the location gets an urgent task to raise it as an incident.
     */
    safeguarding: z.boolean().optional(),
  })
  .refine((v) => v.kind === "positive" || v.safeguarding !== undefined, {
    path: ["safeguarding"],
    message: "Say whether this is a safeguarding matter.",
  })
  .meta({ id: "RecordAgencyFeedback" });

export const AgencyFeedbackItem = z
  .object({
    id: uuid,
    workerId: uuid,
    bookingId: uuid,
    locationId: uuid,
    kind: z.enum(["positive", "concern", "do_not_rebook"]),
    notes: z.string(),
    createdBy: uuid.nullable(),
    createdAt: isoDateTime,
  })
  .meta({ id: "AgencyFeedbackItem" });

export const AgencyFeedbackList = z
  .object({ items: z.array(AgencyFeedbackItem) })
  .meta({ id: "AgencyFeedbackList" });

export const AgencyCostList = z
  .object({
    locationId: uuid,
    from: isoDate,
    to: isoDate,
    items: z.array(
      z.object({
        agencyId: uuid.nullable(),
        kind: AgencyWorkerKind,
        bookings: z.number().int(),
        costPence: z.number().int(),
      }),
    ),
    totalPence: z.number().int(),
  })
  .meta({ id: "AgencyCostList" });
