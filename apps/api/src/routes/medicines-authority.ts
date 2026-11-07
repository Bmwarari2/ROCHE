import {
  ChangeHomelyProtocol,
  CheckHomelyDose,
  CovertRecordList,
  CovertRecordOut,
  EndCovertRecord,
  HomelyDoseCheck,
  HomelyDoseEnteredInError,
  HomelyDoseList,
  HomelyDoseOut,
  HomelyProtocolList,
  HomelyProtocolOut,
  NewCovertRecord,
  NewHomelyProtocol,
  NewSelfAdminAssessment,
  PersonSelfAdministration,
  RecordHomelyDose,
  ReviewCovertRecord,
  SelfAdminAssessmentOut,
  WithdrawHomelyProtocol,
} from "@harbour/contracts";
import {
  bestInterestsDecision,
  capacityAssessment,
  covertMedicationRecord,
  homelyRemedyAdministration,
  homelyRemedyProtocol,
  medication,
  selfAdministrationAssessment,
  type Transaction,
  task,
  tenantUser,
} from "@harbour/db";
import {
  COVERT_ATTENDEE_ROLE_WORDS,
  COVERT_RATE_KEYS,
  COVERT_RECORD_PROBLEM_WORDS,
  COVERT_STATUS_WORDS,
  type CovertAttendee,
  checkCovertRecord,
  checkHomelyDose,
  checkHomelyProtocol,
  checkSelfAdminAssessment,
  covertStatus,
  HOMELY_DOSE_PROBLEM_WORDS,
  HOMELY_PROTOCOL_PROBLEM_WORDS,
  HOMELY_RATE_KEYS,
  type HomelyDoseProblem,
  homelyProtocolStatus,
  SELF_ADMIN_LEVEL_WORDS,
  SELF_ADMIN_PROBLEM_WORDS,
  SELF_ADMIN_RATE_KEYS,
  type SelfAdminLevel,
  scopeFor,
  scopeReachesLocation,
  selfAdminStatus,
  ukIsoDate,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  requireAnyPermission,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { lockPerson } from "../services/medicines";
import { covertBasisChanged } from "../services/medicines-authority";
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

/**
 * Covert administration, self-administration and homely remedies (Phase 2 slice 38;
 * medicines.md section 15; MEDS-004, MEDS-006, MEDS-007; HZ-026, HZ-120). The domain rules decide
 * every record; the database guards hold the same lines. Harbour records and applies the
 * organisation's decisions and recommends nothing. Audited with ids only.
 */

const tags = ["medicines"];
const COVERT = "medicines.covert.manage" as const;
const MANAGE = "medicines.record.manage" as const;
const ADMINISTER = "medicines.emar.administer" as const;
const READERS = [MANAGE, ADMINISTER, "care.plan.read"] as const;
const IdParam = z.object({ id: z.uuid() });

function audit(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  input: Parameters<typeof auditInTx>[2],
) {
  return auditInTx(tx, access, { ...input, requestId: c.get("requestId") });
}

function refused(code: string, messages: readonly string[]): HttpProblem {
  return new HttpProblem(422, code, "This cannot be recorded like this.", messages.join(" "));
}

/** Database guard refusals, in words; anything else is rethrown. */
const GUARD_WORDS: Record<string, string> = {
  covert_medication_record_closed: "An ended covert record cannot be changed.",
  covert_medication_record_change_needs_reason: "Give a new reason for this change.",
  covert_medication_record_needs_lack_of_capacity_and_best_interests:
    COVERT_RECORD_PROBLEM_WORDS.capacity_not_lacking,
  covert_medication_record_needs_prescriber_and_pharmacist:
    COVERT_RECORD_PROBLEM_WORDS.pharmacist_not_involved,
  self_administration_assessment_other_medicine:
    "Choose only this person's own medicines for the assessment.",
  self_administration_assessment_capacity_mismatch:
    SELF_ADMIN_PROBLEM_WORDS.capacity_assessment_mismatch,
  homely_remedy_protocol_closed: "A withdrawn protocol cannot be changed.",
  homely_remedy_protocol_change_needs_reason: "Give a new reason for this change.",
  homely_remedy_administration_outside_protocol:
    "This dose is outside the protocol: check the protocol, who may give it and where.",
};

/**
 * Runs one write in a savepoint (a nested transaction), so a refused statement leaves the request's
 * transaction usable, and turns the database's refusals into words: a unique clash is a conflict,
 * a guard or check refusal a 422.
 */
async function inSavepoint<T>(tx: Transaction, fn: () => Promise<T>, conflict: string): Promise<T> {
  try {
    return await tx.transaction(async () => fn());
  } catch (error) {
    const e = error as {
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    const code = e.code ?? e.cause?.code;
    const text = `${e.message ?? ""} ${e.cause?.message ?? ""}`;
    if (code === "23505") throw problems.conflict(conflict);
    if (code === "23514") {
      const key = Object.keys(GUARD_WORDS).find((k) => text.includes(k));
      throw refused("refused", [
        key ? (GUARD_WORDS[key] as string) : "This breaks a rule for this record.",
      ]);
    }
    throw error;
  }
}

// Covert records

type CovertRow = typeof covertMedicationRecord.$inferSelect;

async function medicineNames(
  tx: Transaction,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: medication.id, name: medication.productName })
    .from(medication)
    .where(inArray(medication.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function covertOut(
  r: CovertRow,
  name: string,
  today: string,
  basisChanged = false,
): z.infer<typeof CovertRecordOut> {
  const status = covertStatus({ ...r, basisChanged }, today);
  const attendees = r.attendees as CovertAttendee[];
  return {
    id: r.id,
    personId: r.personId,
    medicationId: r.medicationId,
    medicineId: r.medicineId,
    medicineName: name,
    capacityAssessmentId: r.capacityAssessmentId,
    bestInterestsDecisionId: r.bestInterestsDecisionId,
    attendees: attendees.map((a) => ({
      role: a.role,
      roleWords: COVERT_ATTENDEE_ROLE_WORDS[a.role],
      name: a.name,
    })),
    method: r.method,
    pharmacistAdvice: r.pharmacistAdvice,
    startsOn: r.startsOn,
    reviewOn: r.reviewOn,
    reviewedOn: r.reviewedOn,
    endedOn: r.endedOn,
    endedReason: r.endedReason,
    changeReason: r.changeReason,
    status,
    statusWords: COVERT_STATUS_WORDS[status],
    version: r.version,
  };
}

/** The capacity assessment and best-interests decision as the rules read them. */
async function mcaFacts(
  tx: Transaction,
  personId: string,
  capacityAssessmentId: string,
  bestInterestsDecisionId: string,
) {
  const [cap] = await tx
    .select()
    .from(capacityAssessment)
    .where(eq(capacityAssessment.id, capacityAssessmentId));
  const [capLater] = await tx
    .select({ id: capacityAssessment.id })
    .from(capacityAssessment)
    .where(eq(capacityAssessment.supersedesId, capacityAssessmentId))
    .limit(1);
  const [bi] = await tx
    .select()
    .from(bestInterestsDecision)
    .where(eq(bestInterestsDecision.id, bestInterestsDecisionId));
  const [biLater] = await tx
    .select({ id: bestInterestsDecision.id })
    .from(bestInterestsDecision)
    .where(eq(bestInterestsDecision.supersedesId, bestInterestsDecisionId))
    .limit(1);
  return {
    capacity: cap
      ? {
          personId: cap.personId,
          outcome: cap.outcome as "has_capacity" | "lacks_capacity",
          decisionKind: cap.decisionKind,
          superseded: capLater !== undefined,
        }
      : null,
    bestInterests: bi
      ? {
          personId: bi.personId,
          capacityAssessmentId: bi.capacityAssessmentId,
          decidedOn: ukIsoDate(bi.decidedAt),
          superseded: biLater !== undefined,
        }
      : null,
    personId,
  };
}

function covertRefusal(problemsFound: readonly (keyof typeof COVERT_RECORD_PROBLEM_WORDS)[]) {
  return refused(
    `covert_${problemsFound[0]}`,
    problemsFound.map((p) => COVERT_RECORD_PROBLEM_WORDS[p]),
  );
}

async function loadCovert(tx: Transaction, id: string): Promise<CovertRow> {
  const [row] = await tx
    .select()
    .from(covertMedicationRecord)
    .where(and(eq(covertMedicationRecord.id, id), isNull(covertMedicationRecord.deletedAt)));
  if (!row) throw problems.notFound();
  return row;
}

// Homely remedies

type ProtocolRow = typeof homelyRemedyProtocol.$inferSelect;
type DoseRow = typeof homelyRemedyAdministration.$inferSelect;

function protocolOut(r: ProtocolRow, today: string): z.infer<typeof HomelyProtocolOut> {
  const status = homelyProtocolStatus(
    { withdrawn: r.withdrawnAt !== null, reviewOn: r.reviewOn },
    today,
  );
  return {
    id: r.id,
    locationId: r.locationId,
    productName: r.productName,
    vmpId: r.vmpId,
    indication: r.indication,
    doseQuantity: Number(r.doseQuantity),
    unitName: r.unitName,
    minIntervalHours: Number(r.minIntervalHours),
    maxDailyQuantity: Number(r.maxDailyQuantity),
    maxDays: r.maxDays,
    authorisedMemberIds: [...r.authorisedMemberIds],
    approvedByName: r.approvedByName,
    approvedByRole: r.approvedByRole as "gp" | "pharmacist",
    approvedOn: r.approvedOn,
    reviewOn: r.reviewOn,
    withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    withdrawnReason: r.withdrawnReason,
    changeReason: r.changeReason,
    status,
    statusWords:
      status === "in_use"
        ? "In use"
        : status === "review_overdue"
          ? "Review overdue: not to be used until reviewed"
          : "Withdrawn",
    version: r.version,
  };
}

function doseOut(r: DoseRow, protocol: ProtocolRow | undefined, rows: readonly DoseRow[]) {
  const marked = rows.find((x) => x.supersedesId === r.id);
  return {
    id: r.id,
    personId: r.personId,
    protocolId: r.protocolId,
    protocolVersion: r.protocolVersion,
    productName: protocol?.productName ?? "",
    outcome: r.outcome as "given" | "entered_in_error",
    quantity: r.quantity === null ? null : Number(r.quantity),
    unitName: protocol?.unitName ?? "",
    reason: r.reason,
    givenAt: r.givenAt.toISOString(),
    givenBy: r.givenBy,
    allergiesChecked: r.allergiesChecked,
    medicinesCompared: r.medicinesCompared,
    alreadyGivenReason: r.alreadyGivenReason,
    flags: [...r.flags],
    recordedAt: r.recordedAt.toISOString(),
    supersedesId: r.supersedesId,
    correctionReason: r.correctionReason,
    enteredInErrorBy: marked?.id ?? null,
  } satisfies z.infer<typeof HomelyDoseOut>;
}

async function protocolFor(tx: Transaction, id: string): Promise<ProtocolRow> {
  const [row] = await tx
    .select()
    .from(homelyRemedyProtocol)
    .where(and(eq(homelyRemedyProtocol.id, id), isNull(homelyRemedyProtocol.deletedAt)));
  if (!row) throw problems.notFound();
  return row;
}

async function checkProtocol(
  tx: Transaction,
  tenantId: string,
  body: z.infer<typeof NewHomelyProtocol>,
) {
  const named = await tx
    .select({ id: tenantUser.id })
    .from(tenantUser)
    .where(inArray(tenantUser.id, body.authorisedMemberIds));
  if (named.length !== new Set(body.authorisedMemberIds).size) {
    throw refused("homely_unknown_member", ["Name only members of your organisation."]);
  }
  const found = checkHomelyProtocol(body, {
    today: ukIsoDate(new Date()),
    maxDaysCeiling: await rateNumber(tx, tenantId, HOMELY_RATE_KEYS.maxDaysCeiling),
    reviewMaxDays: await rateNumber(tx, tenantId, HOMELY_RATE_KEYS.reviewMaxDays),
  });
  if (found.length > 0) {
    throw refused(
      `homely_${found[0]}`,
      found.map((p) => HOMELY_PROTOCOL_PROBLEM_WORDS[p]),
    );
  }
}

const protocolValues = (body: z.infer<typeof NewHomelyProtocol>) => ({
  productName: body.productName,
  vmpId: body.vmpId,
  indication: body.indication,
  doseQuantity: String(body.doseQuantity),
  unitName: body.unitName,
  minIntervalHours: String(body.minIntervalHours),
  maxDailyQuantity: String(body.maxDailyQuantity),
  maxDays: body.maxDays,
  authorisedMemberIds: body.authorisedMemberIds,
  approvedByName: body.approvedByName,
  approvedByRole: body.approvedByRole,
  approvedOn: body.approvedOn,
  reviewOn: body.reviewOn,
});

/** The person's homely remedy doses, latest records only, oldest first. */
async function personDoses(tx: Transaction, personId: string): Promise<DoseRow[]> {
  return tx
    .select()
    .from(homelyRemedyAdministration)
    .where(eq(homelyRemedyAdministration.personId, personId))
    .orderBy(homelyRemedyAdministration.givenAt);
}

export const medicinesAuthorityRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/covert-medicines",
      tags,
      summary: "A person's covert administration records",
      description:
        "medicines.record.manage, medicines.emar.administer or care.plan.read, in the person's scope. Audited with ids only.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(CovertRecordList, "Covert records, newest first"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await tx
          .select()
          .from(covertMedicationRecord)
          .where(
            and(eq(covertMedicationRecord.personId, id), isNull(covertMedicationRecord.deletedAt)),
          )
          .orderBy(desc(covertMedicationRecord.startsOn));
        const names = await medicineNames(
          tx,
          rows.map((r) => r.medicationId),
        );
        await audit(c, tx, access, {
          action: "medicines.covert.viewed",
          resourceType: "person",
          resourceId: id,
          scope: { personId: id, count: rows.length },
        });
        const today = ukIsoDate(new Date());
        const changed = await covertBasisChanged(
          tx,
          rows.map((r) => r.id),
        );
        return {
          items: rows.map((r) =>
            covertOut(r, names.get(r.medicationId) ?? "", today, changed.has(r.id)),
          ),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/covert-medicines",
      tags,
      summary: "Record that one medicine is given covertly, under a best-interests decision",
      description:
        "medicines.covert.manage at the person's home. Needs the person's capacity assessment for covert medicines finding a lack of capacity, the best-interests decision after it, the prescriber and a pharmacist among those involved, the method and the pharmacist's advice, and a review within the rate table's days. One open record per medicine. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewCovertRecord } } },
      },
      responses: {
        201: jsonBody(CovertRecordOut, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, COVERT);
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, personId);
        requireWrite(person, "care_plan");
        if (!scopeReachesLocation(scopeFor(access.effective, COVERT), person.locationId)) {
          throw problems.forbidden();
        }
        const [entry] = await tx
          .select({
            id: medication.id,
            personId: medication.personId,
            name: medication.productName,
          })
          .from(medication)
          .where(eq(medication.id, body.medicationId));
        if (!entry || entry.personId !== personId) {
          throw refused("covert_other_medicine", ["Choose one of this person's medicines."]);
        }
        const facts = await mcaFacts(
          tx,
          personId,
          body.capacityAssessmentId,
          body.bestInterestsDecisionId,
        );
        const found = checkCovertRecord(
          { ...facts, ...body },
          {
            today: ukIsoDate(new Date()),
            reviewMaxDays: await rateNumber(
              tx,
              access.tenantId,
              COVERT_RATE_KEYS.reviewMaxDays,
              person.nation,
            ),
          },
        );
        if (found.length > 0) throw covertRefusal(found);
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .insert(covertMedicationRecord)
              .values({
                personId,
                medicationId: body.medicationId,
                // Set by the guard from the entry; a placeholder the guard overwrites.
                medicineId: body.medicationId,
                capacityAssessmentId: body.capacityAssessmentId,
                bestInterestsDecisionId: body.bestInterestsDecisionId,
                attendees: body.attendees,
                method: body.method,
                pharmacistAdvice: body.pharmacistAdvice,
                startsOn: body.startsOn,
                reviewOn: body.reviewOn,
              })
              .returning(),
          "This medicine already has an open covert record: review or end it instead.",
        );
        const stored = row as CovertRow;
        await audit(c, tx, access, {
          action: "medicines.covert.recorded",
          resourceType: "covert_medication_record",
          resourceId: stored.id,
          scope: { personId, medicineId: stored.medicineId },
        });
        return covertOut(stored, entry.name, ukIsoDate(new Date()));
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/covert-medicines/{id}/review",
      tags,
      summary: "Record a review of a covert record",
      description:
        "medicines.covert.manage at the person's home. The same evidence as a new record, the date reviewed, the next review within the rate table's days from it, a reason, and the version read. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ReviewCovertRecord } } },
      },
      responses: {
        200: jsonBody(CovertRecordOut, "Reviewed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, COVERT);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const current = await loadCovert(tx, id);
        const person = await loadPerson(tx, current.personId);
        requireWrite(person, "care_plan");
        if (!scopeReachesLocation(scopeFor(access.effective, COVERT), person.locationId)) {
          throw problems.forbidden();
        }
        if (current.endedOn !== null) {
          throw refused("covert_closed", ["An ended covert record cannot be reviewed."]);
        }
        const today = ukIsoDate(new Date());
        if (body.reviewedOn > today || body.reviewedOn < current.startsOn) {
          throw refused("covert_reviewed_on", [
            "The review date must be from the start of the record to today.",
          ]);
        }
        const facts = await mcaFacts(
          tx,
          current.personId,
          body.capacityAssessmentId,
          body.bestInterestsDecisionId,
        );
        const found = checkCovertRecord(
          { ...facts, ...body, startsOn: body.reviewedOn },
          {
            today,
            reviewMaxDays: await rateNumber(
              tx,
              access.tenantId,
              COVERT_RATE_KEYS.reviewMaxDays,
              person.nation,
            ),
          },
        );
        if (found.length > 0) throw covertRefusal(found);
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .update(covertMedicationRecord)
              .set({
                capacityAssessmentId: body.capacityAssessmentId,
                bestInterestsDecisionId: body.bestInterestsDecisionId,
                attendees: body.attendees,
                method: body.method,
                pharmacistAdvice: body.pharmacistAdvice,
                reviewedOn: body.reviewedOn,
                reviewOn: body.reviewOn,
                changeReason: body.reason,
              })
              .where(
                and(
                  eq(covertMedicationRecord.id, id),
                  eq(covertMedicationRecord.version, body.version),
                ),
              )
              .returning(),
          "Read the record again and resend.",
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.covert.reviewed",
          resourceType: "covert_medication_record",
          resourceId: id,
          scope: { personId: current.personId },
        });
        const names = await medicineNames(tx, [row.medicationId]);
        return covertOut(row, names.get(row.medicationId) ?? "", today);
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/covert-medicines/{id}/end",
      tags,
      summary: "End a covert record",
      description:
        "medicines.covert.manage at the person's home, with a reason and the version read. A covert dose after the end is flagged and escalated. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: EndCovertRecord } } },
      },
      responses: {
        200: jsonBody(CovertRecordOut, "Ended"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, COVERT);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const current = await loadCovert(tx, id);
        const person = await loadPerson(tx, current.personId);
        requireWrite(person, "care_plan");
        if (!scopeReachesLocation(scopeFor(access.effective, COVERT), person.locationId)) {
          throw problems.forbidden();
        }
        if (current.endedOn !== null) {
          throw refused("covert_closed", ["This covert record has already ended."]);
        }
        if (body.endedOn < current.startsOn) {
          throw refused("covert_ended_on", ["The end cannot be before the start."]);
        }
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .update(covertMedicationRecord)
              .set({ endedOn: body.endedOn, endedReason: body.reason, changeReason: body.reason })
              .where(
                and(
                  eq(covertMedicationRecord.id, id),
                  eq(covertMedicationRecord.version, body.version),
                ),
              )
              .returning(),
          "Read the record again and resend.",
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.covert.ended",
          resourceType: "covert_medication_record",
          resourceId: id,
          scope: { personId: current.personId },
        });
        const names = await medicineNames(tx, [row.medicationId]);
        return covertOut(row, names.get(row.medicationId) ?? "", ukIsoDate(new Date()));
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/self-administration",
      tags,
      summary: "A person's self-administration assessments, and where each medicine stands",
      description:
        "medicines.record.manage, medicines.emar.administer or care.plan.read, in the person's scope. Audited with ids only.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(PersonSelfAdministration, "Assessments, newest first"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await tx
          .select()
          .from(selfAdministrationAssessment)
          .where(eq(selfAdministrationAssessment.personId, id))
          .orderBy(
            desc(selfAdministrationAssessment.assessedOn),
            desc(selfAdministrationAssessment.recordedAt),
          );
        const entries = await tx
          .select({
            medicineId: medication.medicineId,
            name: medication.productName,
            version: medication.version,
          })
          .from(medication)
          .where(eq(medication.personId, id))
          .orderBy(desc(medication.version));
        const names = new Map<string, string>();
        for (const e of entries) if (!names.has(e.medicineId)) names.set(e.medicineId, e.name);
        const today = ukIsoDate(new Date());
        const assessments = rows.map((r) => ({ ...r, level: r.level as SelfAdminLevel }));
        await audit(c, tx, access, {
          action: "medicines.self_administration.viewed",
          resourceType: "person",
          resourceId: id,
          scope: { personId: id, count: rows.length },
        });
        return {
          assessments: rows.map(selfAdminOut),
          medicines: [...names].map(([medicineId, name]) => {
            const state = selfAdminStatus(assessments, medicineId, today);
            return {
              medicineId,
              name,
              status: state.status,
              level: state.level,
              statusWords:
                state.status === "not_assessed"
                  ? "Not assessed: staff give it"
                  : `${SELF_ADMIN_LEVEL_WORDS[state.level as SelfAdminLevel]}${
                      state.status === "review_overdue" ? " (review overdue)" : ""
                    }`,
            };
          }),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/self-administration",
      tags,
      summary: "Record a self-administration assessment or its review",
      description:
        "medicines.record.manage in the person's scope. The person's choice, capacity (assumed, or a linked assessment that says so), dexterity and storage, and the level a person decided on, for the medicines listed; a review within the rate table's days. A review is a new assessment. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewSelfAdminAssessment } } },
      },
      responses: {
        201: jsonBody(SelfAdminAssessmentOut, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, personId);
        requireWrite(person, "care_plan");
        let cap = null;
        if (body.capacityAssessmentId) {
          const facts = await mcaFacts(
            tx,
            personId,
            body.capacityAssessmentId,
            body.capacityAssessmentId,
          );
          cap = facts.capacity;
        }
        const found = checkSelfAdminAssessment(
          { ...body, personId, capacityAssessment: cap },
          {
            today: ukIsoDate(new Date()),
            reviewMaxDays: await rateNumber(
              tx,
              access.tenantId,
              SELF_ADMIN_RATE_KEYS.reviewMaxDays,
              person.nation,
            ),
          },
        );
        if (found.length > 0) {
          throw refused(
            `self_admin_${found[0]}`,
            found.map((p) => SELF_ADMIN_PROBLEM_WORDS[p]),
          );
        }
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .insert(selfAdministrationAssessment)
              .values({
                personId,
                medicineIds: [...new Set(body.medicineIds)],
                choice: body.choice,
                capacity: body.capacity,
                capacityAssessmentId: body.capacityAssessmentId,
                dexterity: body.dexterity,
                storage: body.storage,
                level: body.level,
                notes: body.notes,
                assessedOn: body.assessedOn,
                reviewOn: body.reviewOn,
                assessedBy: access.tenantUserId,
              })
              .returning(),
          "Read the assessments again and resend.",
        );
        const stored = row as typeof selfAdministrationAssessment.$inferSelect;
        await audit(c, tx, access, {
          action: "medicines.self_administration.assessed",
          resourceType: "self_administration_assessment",
          resourceId: stored.id,
          scope: { personId, level: stored.level, medicines: stored.medicineIds.length },
        });
        return selfAdminOut(stored);
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/locations/{id}/homely-remedies",
      tags,
      summary: "A home's homely remedy protocols",
      description:
        "medicines.record.manage, medicines.emar.administer or care.plan.read, at a home in scope.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(HomelyProtocolList, "Protocols"),
        ...errorResponses,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        const rows = await tx
          .select()
          .from(homelyRemedyProtocol)
          .where(
            and(eq(homelyRemedyProtocol.locationId, id), isNull(homelyRemedyProtocol.deletedAt)),
          )
          .orderBy(homelyRemedyProtocol.productName);
        const today = ukIsoDate(new Date());
        return { items: rows.map((r) => protocolOut(r, today)) };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/locations/{id}/homely-remedies",
      tags,
      summary: "Add a homely remedy protocol agreed with a GP or pharmacist",
      description:
        "medicines.record.manage at the home. Every figure is the protocol's; the days before the GP is asked and the review are within the rate table's limits. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: NewHomelyProtocol } } },
      },
      responses: {
        201: jsonBody(HomelyProtocolOut, "Added"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id: locationId } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!scopeReachesLocation(scopeFor(access.effective, MANAGE), locationId)) {
        throw problems.forbidden();
      }
      const out = await withTenant(c, async (tx) => {
        await checkProtocol(tx, access.tenantId, body);
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .insert(homelyRemedyProtocol)
              .values({ locationId, ...protocolValues(body) })
              .returning(),
          "Read the protocols again and resend.",
        ).catch((error: { code?: string; cause?: { code?: string } }) => {
          if ((error.code ?? error.cause?.code) === "23503") throw problems.notFound();
          throw error;
        });
        const stored = row as ProtocolRow;
        await audit(c, tx, access, {
          action: "medicines.homely_protocol.added",
          resourceType: "homely_remedy_protocol",
          resourceId: stored.id,
          scope: { locationId },
        });
        return protocolOut(stored, ukIsoDate(new Date()));
      });
      return c.json(out, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/homely-remedies/{id}/change",
      tags,
      summary: "Change a homely remedy protocol, with a reason",
      description:
        "medicines.record.manage at the home, with the version read. Doses already given keep the version they were checked against. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: ChangeHomelyProtocol } } },
      },
      responses: {
        200: jsonBody(HomelyProtocolOut, "Changed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const { reason, version, ...body } = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const current = await protocolFor(tx, id);
        if (!scopeReachesLocation(scopeFor(access.effective, MANAGE), current.locationId)) {
          throw problems.forbidden();
        }
        if (current.withdrawnAt !== null) {
          throw refused("homely_closed", ["A withdrawn protocol cannot be changed."]);
        }
        await checkProtocol(tx, access.tenantId, body);
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .update(homelyRemedyProtocol)
              .set({ ...protocolValues(body), changeReason: reason })
              .where(
                and(eq(homelyRemedyProtocol.id, id), eq(homelyRemedyProtocol.version, version)),
              )
              .returning(),
          "Read the protocol again and resend.",
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.homely_protocol.changed",
          resourceType: "homely_remedy_protocol",
          resourceId: id,
          scope: { locationId: current.locationId },
        });
        return protocolOut(row, ukIsoDate(new Date()));
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/homely-remedies/{id}/withdraw",
      tags,
      summary: "Withdraw a homely remedy protocol",
      description:
        "medicines.record.manage at the home, with a reason and the version read. A withdrawn protocol is never used again. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: WithdrawHomelyProtocol } } },
      },
      responses: {
        200: jsonBody(HomelyProtocolOut, "Withdrawn"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const out = await withTenant(c, async (tx) => {
        const current = await protocolFor(tx, id);
        if (!scopeReachesLocation(scopeFor(access.effective, MANAGE), current.locationId)) {
          throw problems.forbidden();
        }
        if (current.withdrawnAt !== null) {
          throw refused("homely_closed", ["This protocol has already been withdrawn."]);
        }
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .update(homelyRemedyProtocol)
              .set({
                withdrawnAt: new Date(),
                withdrawnReason: body.reason,
                changeReason: body.reason,
              })
              .where(
                and(
                  eq(homelyRemedyProtocol.id, id),
                  eq(homelyRemedyProtocol.version, body.version),
                ),
              )
              .returning(),
          "Read the protocol again and resend.",
        );
        if (!row) throw problems.conflict();
        await audit(c, tx, access, {
          action: "medicines.homely_protocol.withdrawn",
          resourceType: "homely_remedy_protocol",
          resourceId: id,
          scope: { locationId: current.locationId },
        });
        return protocolOut(row, ukIsoDate(new Date()));
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/people/{id}/homely-remedy-doses",
      tags,
      summary: "A person's homely remedy doses",
      description:
        "medicines.record.manage, medicines.emar.administer or care.plan.read, in the person's scope. Audited with ids only.",
      security,
      request: { params: IdParam },
      responses: {
        200: jsonBody(HomelyDoseList, "Doses, newest first"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [...READERS]);
      const { id } = c.req.valid("param");
      const out = await withTenant(c, async (tx) => {
        await loadPerson(tx, id);
        const rows = await personDoses(tx, id);
        const protocols = await protocolsById(
          tx,
          rows.map((r) => r.protocolId),
        );
        await audit(c, tx, access, {
          action: "medicines.homely_dose.viewed",
          resourceType: "person",
          resourceId: id,
          scope: { personId: id, count: rows.length },
        });
        return {
          items: rows.map((r) => doseOut(r, protocols.get(r.protocolId), rows)).reverse(),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/homely-remedy-doses/check",
      tags,
      summary: "Check a homely remedy dose against the protocol before giving it",
      description:
        "medicines.emar.administer. Says in words whether the dose is within the protocol now; records nothing.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: CheckHomelyDose } } },
      },
      responses: {
        200: jsonBody(HomelyDoseCheck, "What the check found"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, ADMINISTER);
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const out = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, personId);
        const protocol = await protocolFor(tx, body.protocolId);
        if (protocol.locationId !== person.locationId) {
          throw refused("homely_other_home", ["This protocol is for another home."]);
        }
        const rows = await personDoses(tx, personId);
        const found = await homelyProblems(
          tx,
          access,
          person,
          protocol,
          rows,
          body.quantity,
          now,
          now,
        );
        await audit(c, tx, access, {
          action: "medicines.homely_dose.checked",
          resourceType: "person",
          resourceId: personId,
          scope: { personId, protocolId: protocol.id, problems: found },
        });
        return {
          problems: found.map((p) => ({ problem: p, message: HOMELY_DOSE_PROBLEM_WORDS[p] })),
        };
      });
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/people/{id}/homely-remedy-doses",
      tags,
      summary: "Record a homely remedy dose under the home's protocol",
      description:
        "medicines.emar.administer, by a member the protocol names, for a person at the protocol's home, with the person's allergies checked. Refused in words when it is outside the protocol: withdrawn or past review, another dose, too soon, over the most in 24 hours, the protocol's days used (ask the GP), or the same product prescribed; doses of the same product under other protocols at the home count. A dose already given (`alreadyGiven`, with when and why) is recorded with what the check found as flags and escalated urgently. Resending the same id returns the same record. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: RecordHomelyDose } } },
      },
      responses: {
        200: jsonBody(HomelyDoseOut, "Already recorded with this id"),
        201: jsonBody(HomelyDoseOut, "Recorded"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, ADMINISTER);
      const { id: personId } = c.req.valid("param");
      const body = c.req.valid("json");
      const now = new Date();
      const result = await withTenant(c, async (tx) => {
        const person = await loadPerson(tx, personId);
        await lockPerson(tx, personId);
        const rows = await personDoses(tx, personId);
        const resent = rows.find((r) => r.id === body.id);
        if (resent) {
          if (
            resent.protocolId !== body.protocolId ||
            resent.outcome !== "given" ||
            Number(resent.quantity) !== body.quantity ||
            resent.givenBy !== access.tenantUserId ||
            resent.reason !== body.reason
          ) {
            throw problems.conflict(
              "This record id cannot be used. Read the record again and resend.",
            );
          }
          const p = await protocolsById(tx, [resent.protocolId]);
          return { status: 200 as const, dose: doseOut(resent, p.get(resent.protocolId), rows) };
        }
        const at = body.alreadyGiven ? new Date(body.alreadyGiven.givenAt) : now;
        requireWrite(person, "care_note", at);
        const protocol = await protocolFor(tx, body.protocolId);
        if (protocol.locationId !== person.locationId) {
          throw refused("homely_other_home", ["This protocol is for another home."]);
        }
        const found = await homelyProblems(
          tx,
          access,
          person,
          protocol,
          rows,
          body.quantity,
          at,
          now,
        );
        const deny = async (problemsFound: readonly HomelyDoseProblem[]) => {
          await audit(c, tx, access, {
            action: "medicines.homely_dose.recorded",
            outcome: "denied",
            resourceType: "homely_remedy_administration",
            resourceId: body.id,
            scope: { personId, protocolId: protocol.id, problems: [...problemsFound] },
          });
          return {
            status: 422 as const,
            problem: refused(
              `homely_${problemsFound[0]}`,
              problemsFound.map((p) => HOMELY_DOSE_PROBLEM_WORDS[p]),
            ),
          };
        };
        // A time in the future is never recorded; otherwise a dose already given is recorded with
        // what the check found (HZ-004), and one not yet given is refused (H-1356).
        if (found.includes("given_in_future")) return deny(["given_in_future"]);
        if (found.length > 0 && !body.alreadyGiven) return deny(found);
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .insert(homelyRemedyAdministration)
              .values({
                id: body.id,
                personId,
                protocolId: protocol.id,
                protocolVersion: protocol.version,
                outcome: "given",
                quantity: String(body.quantity),
                reason: body.reason,
                givenAt: at,
                givenBy: access.tenantUserId,
                allergiesChecked: body.allergiesChecked,
                medicinesCompared: body.medicinesCompared,
                alreadyGivenReason: body.alreadyGiven?.reason ?? null,
                flags: found,
              })
              .returning(),
          "This record id cannot be used. Read the record again and resend.",
        );
        const stored = row as DoseRow;
        if (found.length > 0) {
          await tx.insert(task).values({
            kind: HOMELY_REVIEW_TASK,
            title: "A homely remedy was given outside its protocol: review now",
            requiredPermission: MANAGE,
            personId,
            locationId: person.locationId,
            sourceType: "homely_remedy_administration",
            sourceId: stored.id,
            assigneeRoleKey: "clinical_lead",
            dueAt: now,
            priority: "urgent",
            details: { problems: found },
          });
        }
        await audit(c, tx, access, {
          action: "medicines.homely_dose.recorded",
          resourceType: "homely_remedy_administration",
          resourceId: stored.id,
          scope: {
            personId,
            protocolId: protocol.id,
            flags: found,
            allergiesChecked: true,
            medicinesCompared: true,
          },
        });
        return { status: 201 as const, dose: doseOut(stored, protocol, [...rows, stored]) };
      });
      if (result.status === 422) throw result.problem;
      return c.json(result.dose, result.status);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/homely-remedy-doses/{id}/entered-in-error",
      tags,
      summary: "Mark a homely remedy dose as entered in error",
      description:
        "The member who gave it (medicines.emar.administer) or medicines.record.manage at the person's home, with a reason. A new record marks the dose; the dose stays, struck through, and no longer counts. Resending the same id returns the same record. Audited with ids only.",
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: HomelyDoseEnteredInError } } },
      },
      responses: {
        200: jsonBody(HomelyDoseOut, "Already marked with this id"),
        201: jsonBody(HomelyDoseOut, "Marked"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireAnyPermission(c, [ADMINISTER, MANAGE]);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await withTenant(c, async (tx) => {
        const [original] = await tx
          .select()
          .from(homelyRemedyAdministration)
          .where(eq(homelyRemedyAdministration.id, id));
        if (!original) throw problems.notFound();
        const person = await loadPerson(tx, original.personId);
        const manages = scopeReachesLocation(scopeFor(access.effective, MANAGE), person.locationId);
        if (original.givenBy !== access.tenantUserId && !manages) throw problems.forbidden();
        await lockPerson(tx, original.personId);
        const p = await protocolsById(tx, [original.protocolId]);
        const [resent] = await tx
          .select()
          .from(homelyRemedyAdministration)
          .where(eq(homelyRemedyAdministration.id, body.id));
        if (resent) {
          if (resent.supersedesId !== original.id || resent.outcome !== "entered_in_error") {
            throw problems.conflict(
              "This record id cannot be used. Read the record again and resend.",
            );
          }
          return {
            status: 200 as const,
            dose: doseOut(resent, p.get(original.protocolId), [original, resent]),
          };
        }
        requireWrite(person, "care_note");
        if (original.outcome !== "given") {
          throw refused("homely_not_a_dose", ["Only a dose can be marked as entered in error."]);
        }
        const [row] = await inSavepoint(
          tx,
          () =>
            tx
              .insert(homelyRemedyAdministration)
              .values({
                id: body.id,
                personId: original.personId,
                protocolId: original.protocolId,
                protocolVersion: original.protocolVersion,
                outcome: "entered_in_error",
                quantity: null,
                reason: null,
                givenAt: original.givenAt,
                givenBy: access.tenantUserId,
                supersedesId: original.id,
                correctionReason: body.reason,
              })
              .returning(),
          "This dose is already marked.",
        );
        const stored = row as DoseRow;
        await audit(c, tx, access, {
          action: "medicines.homely_dose.entered_in_error",
          resourceType: "homely_remedy_administration",
          resourceId: stored.id,
          scope: { personId: original.personId, supersedesId: original.id },
        });
        return {
          status: 201 as const,
          dose: doseOut(stored, p.get(original.protocolId), [original, stored]),
        };
      });
      return c.json(result.dose, result.status);
    },
  );

const HOMELY_REVIEW_TASK = "medicines.homely_remedy.review";

/**
 * What the protocol check finds for a dose at `at`. Earlier doses count under every protocol at the
 * home for the same product (the same dm+d product, or the same name when not coded), so a
 * replaced or second protocol never starts a fresh gap, day or course (clinical review, 06/11/2026).
 */
async function homelyProblems(
  tx: Transaction,
  access: TenantAccess,
  person: { readonly id: string; readonly nation: Parameters<typeof rateNumber>[3] },
  protocol: ProtocolRow,
  rows: readonly DoseRow[],
  quantity: number,
  at: Date,
  now: Date,
): Promise<HomelyDoseProblem[]> {
  const same = await tx
    .select({ id: homelyRemedyProtocol.id })
    .from(homelyRemedyProtocol)
    .where(
      and(
        eq(homelyRemedyProtocol.locationId, protocol.locationId),
        protocol.vmpId !== null
          ? eq(homelyRemedyProtocol.vmpId, protocol.vmpId)
          : sql`lower(${homelyRemedyProtocol.productName}) = lower(${protocol.productName})`,
      ),
    );
  const ids = new Set([protocol.id, ...same.map((x) => x.id)]);
  const marked = new Set(rows.map((r) => r.supersedesId).filter((x): x is string => x !== null));
  const earlier = rows
    .filter((r) => ids.has(r.protocolId) && r.outcome === "given" && !marked.has(r.id))
    .map((r) => ({ at: r.givenAt, quantity: Number(r.quantity) }));
  const current = await tx
    .select({ vmpId: medication.vmpId })
    .from(medication)
    .where(
      and(
        eq(medication.personId, person.id),
        inArray(medication.state, ["not_yet_checked", "checked", "difference_found"]),
      ),
    );
  return checkHomelyDose(
    {
      at,
      now,
      memberId: access.tenantUserId,
      quantity,
      protocol: {
        doseQuantity: Number(protocol.doseQuantity),
        minIntervalHours: Number(protocol.minIntervalHours),
        maxDailyQuantity: Number(protocol.maxDailyQuantity),
        maxDays: protocol.maxDays,
        authorisedMemberIds: protocol.authorisedMemberIds,
        withdrawn: protocol.withdrawnAt !== null,
        reviewOn: protocol.reviewOn,
        vmpId: protocol.vmpId,
      },
      onDate: ukIsoDate(at),
      earlier,
      prescribedVmpIds: current.map((m) => m.vmpId).filter((v): v is string => v !== null),
    },
    {
      courseGapHours: await rateNumber(
        tx,
        access.tenantId,
        HOMELY_RATE_KEYS.courseGapHours,
        person.nation,
      ),
    },
  );
}

function selfAdminOut(
  r: typeof selfAdministrationAssessment.$inferSelect,
): z.infer<typeof SelfAdminAssessmentOut> {
  return {
    id: r.id,
    personId: r.personId,
    medicineIds: [...r.medicineIds],
    choice: r.choice as "wants_to" | "does_not_want_to",
    capacity: r.capacity as "has_capacity" | "lacks_capacity" | "assumed",
    capacityAssessmentId: r.capacityAssessmentId,
    dexterity: r.dexterity as "able" | "able_with_aids" | "unable",
    storage: r.storage as "lockable_storage" | "no_lockable_storage",
    level: r.level as SelfAdminLevel,
    levelWords: SELF_ADMIN_LEVEL_WORDS[r.level as SelfAdminLevel],
    notes: r.notes,
    assessedOn: r.assessedOn,
    reviewOn: r.reviewOn,
    assessedBy: r.assessedBy,
    recordedAt: r.recordedAt.toISOString(),
  };
}

async function protocolsById(
  tx: Transaction,
  ids: readonly string[],
): Promise<Map<string, ProtocolRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(homelyRemedyProtocol)
    .where(inArray(homelyRemedyProtocol.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}
