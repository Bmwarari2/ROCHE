import {
  EditMedicationError,
  MedicationErrorOut,
  MedicationErrorRead,
  MedicationErrorTrend,
  MedicationReviewOut,
  NewMedicationError,
  OverrideReport,
  PersonMedicationReviews,
  RecordMedicationReview,
  ReportPeriod,
  ReviewTracker,
  ScheduleMedicationReview,
  UsageReport,
} from "@harbour/contracts";
import {
  classifierAnswer,
  incident,
  medication,
  medicationAdministration,
  medicationError,
  medicationReview,
  person,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  type AdministrationOutcome,
  checkMedicationErrorRecord,
  checkReviewDone,
  DOSE_TAKEN_OUTCOMES,
  MEDICATION_ERROR_KIND_WORDS,
  MEDICATION_ERROR_PROBLEM_WORDS,
  MEDICATION_ERROR_SOURCE,
  MEDICATION_ERROR_STAGE_WORDS,
  MEDICINES_RATE_KEYS,
  type MedicationErrorKind,
  type MedicationErrorStage,
  medicationErrorPrompts,
  medicationErrorTrend,
  monthsBetween,
  overrideCounts,
  presumedControlledDrug,
  REVIEW_PROBLEM_WORDS,
  REVIEW_STATUS_WORDS,
  reviewStatus,
  USAGE_REPORT_NOTE,
  ukDayBounds,
  ukIsoDate,
  ukMonthOf,
  usageCounts,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  mfaRefusal,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { problems } from "../http/problem";
import { loadPerson, requireWrite } from "../services/people";
import { rateNumber } from "../services/rates";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";
import { mayChange, readIncident } from "./safety-shared";

/**
 * Medication errors on incidents, medication reviews and the medicines reports (Phase 2 slice 45;
 * medicines.md section 14; MEDS-012, MEDS-013; HZ-134). The incident's classifier is not changed:
 * severity, harm and statutory notifications stay there. Prompts (`medicationErrorPrompts`) are
 * returned in words; Harbour sends nothing to CQC, a local authority or an accountable officer.
 * Audit events carry ids only, never what went wrong or an outcome's words.
 */

const tags = ["medicines"];
const REPORT = "safety.incident.report" as const;
const READ = "safety.incident.read" as const;
const RECORD = "medicines.record.manage" as const;
const IdParam = z.object({ id: z.uuid() });
const PeriodQuery = ReportPeriod;

const audit = (
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) => auditInTx(tx, access, { ...input, requestId: c.get("requestId") });

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** A location-wide report is for those whose scope covers the location: never an assigned scope. */
function locationAllowed(access: TenantAccess, locationId: string): boolean {
  const { scope, locationIds } = access.context;
  return scope === "tenant" || (scope === "locations" && locationIds.includes(locationId));
}

/** A report period in UK dates, inclusive, at most the rate table's longest (security review L2). */
async function period(
  tx: Transaction,
  tenantId: string,
  from: string,
  to: string,
): Promise<{ startsAt: Date; endsAt: Date }> {
  if (to < from) throw problems.invalid("The end of the period must be on or after its start.");
  const maxDays = await rateNumber(tx, tenantId, MEDICINES_RATE_KEYS.reportMaxDays);
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > maxDays) throw problems.invalid(`Choose a period of ${maxDays} days or fewer.`);
  return { startsAt: ukDayBounds(from).startsAt, endsAt: ukDayBounds(to).endsAt };
}

/**
 * An incident about a person is part of their care record: MFA, as for the incident itself; and a
 * restricted incident (people the reader cannot see) is refused whole (security review M2, M3).
 */
async function incidentFor(tx: Transaction, access: TenantAccess, incidentId: string) {
  if (!access.mfaSatisfied) throw mfaRefusal(access);
  const found = await readIncident(tx, incidentId);
  if (found.restricted) throw problems.forbidden();
  return found.row;
}

/** The database's refusals of an error record, in words. */
function errorRefusal(error: unknown): never {
  const cause = (error as { cause?: { constraint?: string; message?: string } }).cause;
  const message = `${error instanceof Error ? error.message : String(error)} ${cause?.message ?? ""}`;
  const constraint = (error as { constraint?: string }).constraint ?? cause?.constraint ?? "";
  if (
    constraint === "medication_error_incident_key" ||
    message.includes("medication_error_incident_key")
  )
    throw problems.conflict(
      "This incident already has its medication details: change them instead.",
    );
  if (constraint.includes("medication_fk") || constraint.includes("administration_fk"))
    throw problems.invalid(
      "Choose a medicine and a dose record of the person this error is about.",
    );
  if (message.includes("medication_error_dose_of_other_medicine"))
    throw problems.invalid("The dose record must be of the medicine chosen.");
  if (message.includes("medication_error_not_on_incident"))
    throw problems.invalid(
      "Medication details go on a medication incident, about one of the people on it.",
    );
  if (constraint === "medication_error_cd_report")
    throw problems.invalid(MEDICATION_ERROR_PROBLEM_WORDS.cd_report_incomplete);
  // Any other check the database makes is a refusal in words, never a server error (L4).
  if (
    (error as { code?: string }).code === "23514" ||
    (cause as { code?: string } | undefined)?.code === "23514"
  )
    throw problems.invalid("Some details could not be saved: check each answer and try again.");
  throw error;
}

type ErrorRow = typeof medicationError.$inferSelect;

/**
 * The medicine an error is about: the one named, or the one the dose record was given under, so a
 * controlled drug is presumed from either (slice 45 clinical review B6).
 */
async function medicineOf(
  tx: Transaction,
  medicationId: string | null,
  administrationId: string | null,
): Promise<{ name: string; cdSchedule: string | null } | undefined> {
  let id = medicationId;
  if (id === null && administrationId !== null) {
    const [dose] = await tx
      .select({ medicationId: medicationAdministration.medicationId })
      .from(medicationAdministration)
      .where(eq(medicationAdministration.id, administrationId));
    id = dose?.medicationId ?? null;
  }
  if (id === null) return undefined;
  const [med] = await tx
    .select({ name: medication.productName, cdSchedule: medication.cdSchedule })
    .from(medication)
    .where(eq(medication.id, id));
  return med;
}

async function errorOut(tx: Transaction, row: ErrorRow): Promise<MedicationErrorOut> {
  const [inc] = await tx
    .select({ harmGrade: incident.harmGrade })
    .from(incident)
    .where(eq(incident.id, row.incidentId));
  const med = await medicineOf(tx, row.medicationId, row.administrationId);
  // The incident's own safeguarding question answered "yes" or "no" clears the safeguarding
  // prompt (B13); only the latest answer counts, and "unsure" leaves it showing.
  const [safeguarding] = await tx
    .select({ value: classifierAnswer.value })
    .from(classifierAnswer)
    .where(
      and(
        eq(classifierAnswer.incidentId, row.incidentId),
        eq(classifierAnswer.questionKey, "safeguarding.concern"),
      ),
    )
    .orderBy(desc(classifierAnswer.answeredAt), desc(classifierAnswer.createdAt))
    .limit(1);
  const answered = (v: string | null) => v as "yes" | "no" | "unsure" | null;
  const controlledDrug = presumedControlledDrug(
    answered(row.controlledDrug),
    med?.cdSchedule ?? null,
  );
  const kinds = row.kinds as MedicationErrorKind[];
  const answers = {
    kinds,
    reachedPerson: answered(row.reachedPerson),
    controlledDrug,
    deliberateOrRepeated: answered(row.deliberateOrRepeated),
  };
  const harm = (inc?.harmGrade ?? null) as Parameters<
    typeof medicationErrorPrompts
  >[1]["harmGrade"];
  return {
    id: row.id,
    incidentId: row.incidentId,
    personId: row.personId,
    medicationId: row.medicationId,
    administrationId: row.administrationId,
    kinds,
    stage: row.stage as MedicationErrorStage | null,
    reachedPerson: answers.reachedPerson,
    controlledDrug,
    deliberateOrRepeated: answers.deliberateOrRepeated,
    immediateActions: row.immediateActions,
    clinicianToldAt: iso(row.clinicianToldAt),
    clinicianTold: row.clinicianTold,
    adviceGiven: row.adviceGiven,
    rootCause: row.rootCause,
    cdReportedOn: row.cdReportedOn,
    cdReportReference: row.cdReportReference,
    medicineName: med?.name ?? null,
    controlledDrugPresumed: row.controlledDrug === null && controlledDrug === "yes",
    nearMiss: kinds.includes("omitted_dose")
      ? false
      : answers.reachedPerson === null || answers.reachedPerson === "unsure"
        ? null
        : answers.reachedPerson === "no",
    kindWords: kinds.map((k) => MEDICATION_ERROR_KIND_WORDS[k]),
    stageWords: row.stage ? MEDICATION_ERROR_STAGE_WORDS[row.stage as MedicationErrorStage] : null,
    source: MEDICATION_ERROR_SOURCE,
    prompts: medicationErrorPrompts(answers, {
      cdReported: row.cdReportedOn !== null,
      harmGrade: harm,
      clinicalAdviceRecorded:
        row.clinicianToldAt !== null && row.clinicianTold !== null && row.adviceGiven !== null,
      safeguardingAnswered: safeguarding?.value === "yes" || safeguarding?.value === "no",
    }),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

type ErrorBody = z.infer<typeof EditMedicationError> | z.infer<typeof NewMedicationError>;

async function checkBody(tx: Transaction, access: TenantAccess, body: ErrorBody, occurredAt: Date) {
  const tolerance = await rateNumber(tx, access.tenantId, MEDICINES_RATE_KEYS.clockDriftMinutes);
  const med = await medicineOf(tx, body.medicationId, body.administrationId);
  const found = checkMedicationErrorRecord(
    {
      kinds: body.kinds,
      stage: body.stage,
      reachedPerson: body.reachedPerson,
      controlledDrug: body.controlledDrug,
      deliberateOrRepeated: body.deliberateOrRepeated,
      immediateActions: body.immediateActions,
      clinicianToldAt: body.clinicianToldAt ? new Date(body.clinicianToldAt) : null,
      clinicianTold: body.clinicianTold,
      adviceGiven: body.adviceGiven,
      rootCause: body.rootCause,
      cdReportedOn: body.cdReportedOn,
      cdReportReference: body.cdReportReference,
    },
    {
      now: new Date(),
      clockToleranceMinutes: tolerance,
      occurredAt,
      medicineCdSchedule: med?.cdSchedule ?? null,
      today: ukIsoDate(new Date()),
    },
  );
  if (found.length > 0)
    throw problems.invalid(found.map((p) => MEDICATION_ERROR_PROBLEM_WORDS[p]).join(" "));
}

const columnsOf = (body: ErrorBody) => ({
  medicationId: body.medicationId,
  administrationId: body.administrationId,
  kinds: [...body.kinds],
  stage: body.stage,
  reachedPerson: body.reachedPerson,
  controlledDrug: body.controlledDrug,
  deliberateOrRepeated: body.deliberateOrRepeated,
  immediateActions: body.immediateActions,
  clinicianToldAt: body.clinicianToldAt ? new Date(body.clinicianToldAt) : null,
  clinicianTold: body.clinicianTold,
  adviceGiven: body.adviceGiven,
  rootCause: body.rootCause,
  cdReportedOn: body.cdReportedOn,
  cdReportReference: body.cdReportReference,
});

const personName = (p: { givenName: string; familyName: string; preferredName: string | null }) =>
  `${p.preferredName ?? p.givenName} ${p.familyName}`;

async function reviewFigures(tx: Transaction, tenantId: string) {
  return {
    intervalMonths: await rateNumber(tx, tenantId, MEDICINES_RATE_KEYS.reviewIntervalMonths),
    dueSoonDays: await rateNumber(tx, tenantId, MEDICINES_RATE_KEYS.reviewDueSoonDays),
  };
}

const reviewOut = (r: typeof medicationReview.$inferSelect): MedicationReviewOut => ({
  id: r.id,
  personId: r.personId,
  dueOn: r.dueOn,
  doneOn: r.doneOn,
  clinicianName: r.clinicianName,
  clinicianRole: r.clinicianRole as MedicationReviewOut["clinicianRole"],
  outcome: r.outcome,
  correctionReason: r.correctionReason,
  version: r.version,
});

function trackerLine(
  p: { id: string; givenName: string; familyName: string; preferredName: string | null },
  reviews: readonly (typeof medicationReview.$inferSelect)[],
  figures: { intervalMonths: number; dueSoonDays: number },
  today: string,
) {
  const row = reviewStatus(
    reviews.filter((r) => r.deletedAt === null),
    figures,
    today,
  );
  return {
    personId: p.id,
    name: personName(p),
    ...row,
    statusWords: REVIEW_STATUS_WORDS[row.status],
  };
}

/**
 * The latest administration record per dose given in a period, for people living at the location
 * now: a record corrected by another is left out wherever the correction's time falls (slice 45
 * clinical review B15). Attribution is by the person's current home (spec 14.3; B19, L1).
 */
async function latestAdministrations(
  tx: Transaction,
  locationId: string,
  startsAt: Date,
  endsAt: Date,
) {
  const rows = await tx
    .select({
      id: medicationAdministration.id,
      personId: medicationAdministration.personId,
      medicationId: medicationAdministration.medicationId,
      outcome: medicationAdministration.outcome,
      flags: medicationAdministration.flags,
      administeredBy: medicationAdministration.administeredBy,
      recordedBy: medicationAdministration.recordedBy,
    })
    .from(medicationAdministration)
    .innerJoin(person, eq(person.id, medicationAdministration.personId))
    .where(
      and(
        eq(person.locationId, locationId),
        isNull(person.deletedAt),
        gte(medicationAdministration.givenAt, startsAt),
        lt(medicationAdministration.givenAt, endsAt),
      ),
    );
  const ids = rows.map((r) => r.id);
  const corrected = new Set(
    ids.length === 0
      ? []
      : (
          await tx
            .select({ supersedesId: medicationAdministration.supersedesId })
            .from(medicationAdministration)
            .where(inArray(medicationAdministration.supersedesId, ids))
        ).map((r) => r.supersedesId),
  );
  return rows.filter((r) => !corrected.has(r.id));
}

/** A review change, with the database's reason refusals said in words (clinical review B4). */
async function reviewChange(
  tx: Transaction,
  run: () => Promise<(typeof medicationReview.$inferSelect)[]>,
): Promise<typeof medicationReview.$inferSelect | undefined> {
  try {
    await tx.execute("SAVEPOINT medication_review_change");
    const [row] = await run();
    await tx.execute("RELEASE SAVEPOINT medication_review_change");
    return row;
  } catch (error) {
    await tx.execute("ROLLBACK TO SAVEPOINT medication_review_change");
    const text = `${(error as Error).message} ${(error as { cause?: { message?: string } }).cause?.message ?? ""}`;
    if (text.includes("_needs_reason"))
      throw problems.invalid(
        "Give a new reason for this change: the last one has already been used.",
      );
    throw error;
  }
}

const ChangeReview = z
  .strictObject({
    dueOn: z.iso.date(),
    reason: z.string().trim().min(1).max(500),
    version: z.number().int().min(1),
  })
  .meta({ id: "ChangeMedicationReview" });
const CancelReview = z
  .strictObject({ reason: z.string().trim().min(1).max(500), version: z.number().int().min(1) })
  .meta({ id: "CancelMedicationReview" });

export const medicationErrorsRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/incidents/{id}/medication-error",
      tags,
      summary: "An incident's medication error details",
      description:
        "safety.incident.read, with MFA and the incident's own scope; refused for a restricted incident. The record (or null), with the error kinds in words, their NRLS source and the prompts to act on; Harbour sends nothing. Audited.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(MedicationErrorRead, "The details"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, READ);
      const { id } = c.req.valid("param");
      const body = await withTenant(c, async (tx) => {
        await incidentFor(tx, access, id);
        const [row] = await tx
          .select()
          .from(medicationError)
          .where(and(eq(medicationError.incidentId, id), isNull(medicationError.deletedAt)));
        await audit(c, tx, access, {
          action: "medicines.medication_error.viewed",
          resourceType: "incident",
          resourceId: id,
        });
        return { error: row ? await errorOut(tx, row) : null };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/incidents/{id}/medication-error",
      tags,
      summary: "Add medication error details to a medication incident",
      description:
        "safety.incident.report, with MFA, by the incident's raiser or a manager of incidents where it happened, on a medication incident that is open and not restricted, about one of its people; the medicine and dose record, when given, are that person's and of one entry. One per incident. The classifier is not changed. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewMedicationError } } },
      },
      responses: {
        201: jsonBody(MedicationErrorOut, "Added"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, REPORT);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const inc = await incidentFor(tx, access, id);
        // The raiser or a manager of incidents where it happened, as for the incident (M1).
        if (!(await mayChange(tx, access, inc))) throw problems.forbidden();
        if (inc.status === "closed") throw problems.invalid("A closed incident cannot be changed.");
        if (inc.type !== "medication" || !inc.personIds.includes(body.personId))
          throw problems.invalid(
            "Medication details go on a medication incident, about one of the people on it.",
          );
        await checkBody(tx, access, body, inc.occurredAt);
        let row: ErrorRow | undefined;
        try {
          await tx.execute("SAVEPOINT medication_error_insert");
          [row] = await tx
            .insert(medicationError)
            .values({ incidentId: id, personId: body.personId, ...columnsOf(body) })
            .returning();
          await tx.execute("RELEASE SAVEPOINT medication_error_insert");
        } catch (error) {
          await tx.execute("ROLLBACK TO SAVEPOINT medication_error_insert");
          errorRefusal(error);
        }
        if (!row) throw new Error("medication error not stored");
        await audit(c, tx, access, {
          action: "medicines.medication_error.recorded",
          resourceType: "medication_error",
          resourceId: row.id,
          scope: { incidentId: id },
        });
        return errorOut(tx, row);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/v1/incidents/{id}/medication-error",
      tags,
      summary: "Change an incident's medication error details",
      description:
        "safety.incident.report, with MFA, by the member who added them, the incident's raiser, or a manager of incidents where it happened; never on a closed or restricted incident. The version read must be sent back. Each prompt clears once its evidence is recorded. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: EditMedicationError } } },
      },
      responses: {
        200: jsonBody(MedicationErrorOut, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, REPORT);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const inc = await incidentFor(tx, access, id);
        const [current] = await tx
          .select()
          .from(medicationError)
          .where(and(eq(medicationError.incidentId, id), isNull(medicationError.deletedAt)));
        if (!current) throw problems.notFound();
        // Its author, the incident's raiser, or a manager of incidents where it happened: holding
        // the permission at another home never counts (security review H1).
        if (current.createdBy !== access.tenantUserId && !(await mayChange(tx, access, inc)))
          throw problems.forbidden();
        if (inc.status === "closed") throw problems.invalid("A closed incident cannot be changed.");
        await checkBody(tx, access, body, inc.occurredAt);
        let row: ErrorRow | undefined;
        try {
          await tx.execute("SAVEPOINT medication_error_update");
          [row] = await tx
            .update(medicationError)
            .set(columnsOf(body))
            .where(
              and(eq(medicationError.id, current.id), eq(medicationError.version, body.version)),
            )
            .returning();
          await tx.execute("RELEASE SAVEPOINT medication_error_update");
        } catch (error) {
          await tx.execute("ROLLBACK TO SAVEPOINT medication_error_update");
          errorRefusal(error);
        }
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.medication_error.changed",
          resourceType: "medication_error",
          resourceId: row.id,
          scope: { incidentId: id, cdReported: row.cdReportedOn !== null },
        });
        return errorOut(tx, row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/medication-reviews",
      tags,
      summary: "A person's medication reviews",
      description:
        "medicines.record.manage, for a person in scope. Every review, newest first, and the tracker line: the last done, the next due and its status in words. Audited.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(PersonMedicationReviews, "Reviews"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const [p] = await tx
          .select({
            id: person.id,
            givenName: person.givenName,
            familyName: person.familyName,
            preferredName: person.preferredName,
          })
          .from(person)
          .where(eq(person.id, id));
        if (!p) throw problems.notFound();
        const reviews = await tx
          .select()
          .from(medicationReview)
          .where(and(eq(medicationReview.personId, id), isNull(medicationReview.deletedAt)))
          .orderBy(asc(medicationReview.dueOn));
        const figures = await reviewFigures(tx, access.tenantId);
        await audit(c, tx, access, {
          action: "medicines.medication_review.viewed",
          resourceType: "person",
          resourceId: id,
        });
        return {
          reviews: [...reviews].reverse().map(reviewOut),
          tracker: trackerLine(p, reviews, figures, ukIsoDate(new Date())),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/medication-reviews",
      tags,
      summary: "Schedule a medication review",
      description: "medicines.record.manage, for a person in scope. Audited.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ScheduleMedicationReview } } },
      },
      responses: {
        201: jsonBody(MedicationReviewOut, "Scheduled"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      const { dueOn } = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        // Never for someone who has left or died (people.md rule 3; security review L5).
        requireWrite(await loadPerson(tx, id), "care_plan");
        const [row] = await tx.insert(medicationReview).values({ personId: id, dueOn }).returning();
        if (!row) throw new Error("review not stored");
        await audit(c, tx, access, {
          action: "medicines.medication_review.scheduled",
          resourceType: "medication_review",
          resourceId: row.id,
          scope: { personId: id },
        });
        return reviewOut(row);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medication-reviews/{id}/done",
      tags,
      summary: "Record a medication review as done, or correct it",
      description:
        "medicines.record.manage. The date (not in the future), the clinician's name and role, and the outcome in the clinician's words; Harbour suggests nothing. Changing a review already done needs a correction reason. The version read must be sent back. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordMedicationReview } } },
      },
      responses: {
        200: jsonBody(MedicationReviewOut, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const found = checkReviewDone(body, ukIsoDate(new Date()));
      if (found.length > 0)
        throw problems.invalid(found.map((p) => REVIEW_PROBLEM_WORDS[p]).join(" "));
      const out = await withTenant(c, async (tx) => {
        const [current] = await tx
          .select()
          .from(medicationReview)
          .where(and(eq(medicationReview.id, id), isNull(medicationReview.deletedAt)));
        if (!current) throw problems.notFound();
        requireWrite(
          await loadPerson(tx, current.personId),
          "care_note",
          ukDayBounds(body.doneOn).startsAt,
        );
        if (current.doneOn !== null && !body.correctionReason)
          throw problems.invalid(
            "This review is already recorded as done: give a reason for the correction.",
          );
        const row = await reviewChange(tx, () =>
          tx
            .update(medicationReview)
            .set({
              doneOn: body.doneOn,
              clinicianName: body.clinicianName,
              clinicianRole: body.clinicianRole,
              outcome: body.outcome,
              recordedBy: access.tenantUserId,
              correctionReason:
                current.doneOn !== null
                  ? (body.correctionReason ?? null)
                  : current.correctionReason,
            })
            .where(and(eq(medicationReview.id, id), eq(medicationReview.version, body.version)))
            .returning(),
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action:
            current.doneOn !== null
              ? "medicines.medication_review.corrected"
              : "medicines.medication_review.done",
          resourceType: "medication_review",
          resourceId: id,
          scope: { personId: row.personId },
        });
        return reviewOut(row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medication-reviews/{id}/reschedule",
      tags,
      summary: "Move a booked medication review to another date",
      description:
        "medicines.record.manage. Only a review not yet done, with a reason; the version read must be sent back. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ChangeReview } } },
      },
      responses: {
        200: jsonBody(MedicationReviewOut, "Moved"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const [current] = await tx
          .select()
          .from(medicationReview)
          .where(and(eq(medicationReview.id, id), isNull(medicationReview.deletedAt)));
        if (!current) throw problems.notFound();
        if (current.doneOn !== null)
          throw problems.invalid("A review already done is corrected, not moved.");
        requireWrite(await loadPerson(tx, current.personId), "care_plan");
        const row = await reviewChange(tx, () =>
          tx
            .update(medicationReview)
            .set({ dueOn: body.dueOn, correctionReason: body.reason })
            .where(and(eq(medicationReview.id, id), eq(medicationReview.version, body.version)))
            .returning(),
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.medication_review.rescheduled",
          resourceType: "medication_review",
          resourceId: id,
          scope: { personId: row.personId },
        });
        return reviewOut(row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/medication-reviews/{id}/cancel",
      tags,
      summary: "Cancel a booked medication review",
      description:
        "medicines.record.manage. Only a review not yet done, with a reason; it stays in the history. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CancelReview } } },
      },
      responses: {
        200: jsonBody(MedicationReviewOut, "Cancelled"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const [current] = await tx
          .select()
          .from(medicationReview)
          .where(and(eq(medicationReview.id, id), isNull(medicationReview.deletedAt)));
        if (!current) throw problems.notFound();
        if (current.doneOn !== null)
          throw problems.invalid("A review already done is corrected, not cancelled.");
        requireWrite(await loadPerson(tx, current.personId), "care_plan");
        const row = await reviewChange(tx, () =>
          tx
            .update(medicationReview)
            .set({ deletedAt: new Date(), correctionReason: body.reason })
            .where(and(eq(medicationReview.id, id), eq(medicationReview.version, body.version)))
            .returning(),
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.medication_review.cancelled",
          resourceType: "medication_review",
          resourceId: id,
          scope: { personId: row.personId },
        });
        return reviewOut(row);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medication-reviews",
      tags,
      summary: "Medication review tracker for a location",
      description:
        "medicines.record.manage across the location (not an assigned scope). Each person living there with a medicines entry: the last review, the next due and its status in words, overdue first. Audited.",
      security,
      request: { params: IdParam },
      responses: { 200: jsonBody(ReviewTracker, "Tracker"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      if (!locationAllowed(access, id)) throw problems.forbidden();
      const items = await withTenant(c, async (tx) => {
        const people = await tx
          .selectDistinct({
            id: person.id,
            givenName: person.givenName,
            familyName: person.familyName,
            preferredName: person.preferredName,
          })
          .from(person)
          .innerJoin(medication, eq(medication.personId, person.id))
          .where(and(eq(person.locationId, id), isNull(person.deletedAt)));
        const ids = people.map((p) => p.id);
        const reviews =
          ids.length === 0
            ? []
            : await tx
                .select()
                .from(medicationReview)
                .where(
                  and(inArray(medicationReview.personId, ids), isNull(medicationReview.deletedAt)),
                );
        const figures = await reviewFigures(tx, access.tenantId);
        const today = ukIsoDate(new Date());
        const rank = {
          overdue: 0,
          due_soon: 1,
          not_scheduled: 2,
          not_booked: 3,
          scheduled: 4,
        } as const;
        const lines = people
          .map((p) =>
            trackerLine(
              p,
              reviews.filter((r) => r.personId === p.id),
              figures,
              today,
            ),
          )
          .sort(
            (a, b) =>
              rank[a.status] - rank[b.status] ||
              (a.nextDueOn ?? "9999").localeCompare(b.nextDueOn ?? "9999") ||
              a.name.localeCompare(b.name, "en-GB"),
          );
        await audit(c, tx, access, {
          action: "medicines.medication_review.tracker_viewed",
          resourceType: "location",
          resourceId: id,
          scope: { people: lines.length },
        });
        return lines;
      });
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medicines/override-report",
      tags,
      summary: "Competence overrides and doses recorded after they were given",
      description:
        "medicines.record.manage across the location. Per member, from the latest record per dose given in the period (UK dates, inclusive) to people living there now: doses they gave under a competence override or with no current competence, and doses they recorded after they were given. Information for the manager; no judgement. Audited.",
      security,
      request: { params: IdParam, query: PeriodQuery },
      responses: { 200: jsonBody(OverrideReport, "Report"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      if (!locationAllowed(access, id)) throw problems.forbidden();
      const items = await withTenant(c, async (tx) => {
        const { startsAt, endsAt } = await period(tx, access.tenantId, from, to);
        const counts = overrideCounts(await latestAdministrations(tx, id, startsAt, endsAt));
        const memberIds = counts.map((n) => n.memberId);
        const names = new Map(
          memberIds.length === 0
            ? []
            : (
                await tx
                  .select({ id: tenantUser.id, name: tenantUser.displayName })
                  .from(tenantUser)
                  .where(inArray(tenantUser.id, memberIds))
              ).map((u) => [u.id, u.name]),
        );
        const out = counts
          .map((n) => ({ ...n, name: names.get(n.memberId) ?? null }))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "en-GB"));
        await audit(c, tx, access, {
          action: "medicines.report.override_viewed",
          resourceType: "location",
          resourceId: id,
          scope: { from, to, members: out.length },
        });
        return out;
      });
      return c.json({ from, to, items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medicines/prn-report",
      tags,
      summary: "PRN and psychotropic use (information only)",
      description:
        "medicines.record.manage across the location. Per person living there, the doses taken in the period (UK dates, inclusive) of when-required entries, of entries tagged psychotropic, and of both, by medicine, from the latest record per dose. A count for a clinician to review, never a judgement. Audited.",
      security,
      request: { params: IdParam, query: PeriodQuery },
      responses: { 200: jsonBody(UsageReport, "Report"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      if (!locationAllowed(access, id)) throw problems.forbidden();
      const items = await withTenant(c, async (tx) => {
        const { startsAt, endsAt } = await period(tx, access.tenantId, from, to);
        const latest = await latestAdministrations(tx, id, startsAt, endsAt);
        const medIds = [...new Set(latest.map((r) => r.medicationId))];
        const meds =
          medIds.length === 0
            ? []
            : await tx
                .select({
                  id: medication.id,
                  medicineId: medication.medicineId,
                  name: medication.productName,
                  directions: medication.directions,
                  tags: medication.tags,
                })
                .from(medication)
                .where(inArray(medication.id, medIds));
        // Each dose is classed by the version it was given under (B16).
        const byVersion = new Map(meds.map((m) => [m.id, m]));
        const counts = usageCounts(
          latest.flatMap((r) => {
            const m = byVersion.get(r.medicationId);
            return m
              ? [
                  {
                    personId: r.personId,
                    medicineId: m.medicineId,
                    name: m.name,
                    prn: m.directions === "when_required",
                    psychotropic: m.tags.includes("psychotropic"),
                    taken: DOSE_TAKEN_OUTCOMES.has(r.outcome as AdministrationOutcome),
                  },
                ]
              : [];
          }),
        );
        const personIds = counts.map((r) => r.personId);
        const names = new Map(
          personIds.length === 0
            ? []
            : (
                await tx
                  .select({
                    id: person.id,
                    givenName: person.givenName,
                    familyName: person.familyName,
                    preferredName: person.preferredName,
                  })
                  .from(person)
                  .where(inArray(person.id, personIds))
              ).map((p) => [p.id, personName(p)]),
        );
        const out = counts
          .map((r) => ({
            ...r,
            byMedicine: r.byMedicine.map((m) => ({ ...m })),
            name: names.get(r.personId) ?? "",
          }))
          .sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
        await audit(c, tx, access, {
          action: "medicines.report.prn_viewed",
          resourceType: "location",
          resourceId: id,
          scope: { from, to, people: out.length },
        });
        return out;
      });
      return c.json({ from, to, note: USAGE_REPORT_NOTE, items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/medication-errors/trend",
      tags,
      summary: "Medication errors and near misses by month",
      description:
        "medicines.record.manage across the location. Per UK month in the period (by when the incident happened, every month shown), errors, near misses and those not yet known, by kind and stage, from the incidents one can see. Audited.",
      security,
      request: { params: IdParam, query: PeriodQuery },
      responses: { 200: jsonBody(MedicationErrorTrend, "Trend"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, RECORD);
      const { id } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      if (!locationAllowed(access, id)) throw problems.forbidden();
      const months = await withTenant(c, async (tx) => {
        const { startsAt, endsAt } = await period(tx, access.tenantId, from, to);
        const rows = await tx
          .select({
            occurredAt: incident.occurredAt,
            kinds: medicationError.kinds,
            stage: medicationError.stage,
            reachedPerson: medicationError.reachedPerson,
          })
          .from(medicationError)
          .innerJoin(incident, eq(incident.id, medicationError.incidentId))
          .where(
            and(
              eq(incident.locationId, id),
              isNull(medicationError.deletedAt),
              isNull(incident.deletedAt),
              gte(incident.occurredAt, startsAt),
              lt(incident.occurredAt, endsAt),
            ),
          );
        await audit(c, tx, access, {
          action: "medicines.report.error_trend_viewed",
          resourceType: "location",
          resourceId: id,
          scope: { from, to, errors: rows.length },
        });
        return medicationErrorTrend(
          rows.map((r) => ({
            month: ukMonthOf(r.occurredAt),
            kinds: r.kinds as MedicationErrorKind[],
            stage: r.stage as MedicationErrorStage | null,
            reachedPerson: r.reachedPerson as "yes" | "no" | "unsure" | null,
          })),
          monthsBetween(from.slice(0, 7), to.slice(0, 7)),
        );
      });
      return c.json(
        {
          from,
          to,
          source: MEDICATION_ERROR_SOURCE,
          months: months.map((m) => ({
            ...m,
            byKind: { ...m.byKind } as Record<string, number>,
            byStage: { ...m.byStage } as Record<string, number>,
          })),
        },
        200,
      );
    },
  );
