import {
  accessGrant,
  bodyMapMark,
  candourRecord,
  classifierAnswer,
  dolsAuthorisation,
  escalationChain,
  incident,
  incidentPerson,
  location,
  notification,
  person,
  rateTable,
  role,
  roleAssignment,
  statutoryNotification,
  type Transaction,
  task,
} from "@harbour/db";
import {
  type ClassifierAnswer,
  type ClassifierAnswerValue,
  type ClassifierQuestionKey,
  type ClassifierResult,
  type ClassifierTaskKind,
  classifierAnswerProblem,
  classifyIncident,
  DOLS_NATIONS,
  DOLS_RATE_KEYS,
  type DolsNation,
  type DolsRates,
  detectOutbreaks,
  dolsCqcNotification,
  dolsStatus,
  type EscalationStep,
  type IncidentFacts,
  type IncidentNation,
  type IncidentPersonFacts,
  type IncidentType,
  type InfectionCase,
  NOTIFICATION_KINDS,
  nextEscalationAt,
  type OutbreakAssessment,
  type OutbreakSignal,
  type OutputDeadline,
  type PostFallTaskKind,
  type PressureUlcerCategory,
  postFallChecklist,
  type RateRow,
  resolveDolsRates,
  resolveSafetyRates,
  SAFETY_RATE_KEYS,
  type SafetyRates,
  STATUTORY_NOTIFICATION_WORKFLOW,
  type StatutoryNotificationKind,
  ukIsoDate,
  type YesNoUnsure,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { publish } from "../outbox";
import { bankHolidays, rateNumber } from "./rates";
import { startWorkflow } from "./workflow";

/**
 * Safety rules wired to the database (docs/specs/safety.md; hazards HZ-013 and HZ-027). The
 * classifier in packages/domain decides; this service gathers its inputs, stores its outputs (the
 * drafts with their clocks, the classifier version and reasoning, the tasks) and keeps them in step
 * when an answer or the incident changes. Nothing here decides whether a notification is needed.
 */

type IncidentRow = typeof incident.$inferSelect;
type IncidentPersonRow = typeof incidentPerson.$inferSelect;
type NotificationRow = typeof statutoryNotification.$inferSelect;

// ------------------------------------------------------------------------------------------------
// Tenant-wide scope inside a request (ADR-0033)
// ------------------------------------------------------------------------------------------------

/**
 * Runs `fn` with tenant-wide row-level security in the caller's transaction, then restores the
 * caller's scope. The classifier must see every person on an incident even when the user who
 * answered a question sees only some of them; what it reads never goes back to the user, who gets
 * a response read again under their own scope. The acting user id is unchanged, so every row
 * written still records who caused it.
 */
export async function withTenantWideScope<T>(tx: Transaction, fn: () => Promise<T>): Promise<T> {
  const before = await tx.execute<{ scope: string | null; locations: string | null }>(
    sql`SELECT current_setting('app.scope', true) AS scope,
               current_setting('app.location_ids', true) AS locations`,
  );
  const previous = before.rows[0];
  await tx.execute(
    sql`SELECT set_config('app.scope', 'tenant', true), set_config('app.location_ids', '', true)`,
  );
  const result = await fn();
  await tx.execute(
    sql`SELECT set_config('app.scope', ${previous?.scope || "none"}, true),
               set_config('app.location_ids', ${previous?.locations ?? ""}, true)`,
  );
  return result;
}

// ------------------------------------------------------------------------------------------------
// Rate-table figures
// ------------------------------------------------------------------------------------------------

async function rateRows(tx: Transaction, keys: readonly string[]): Promise<RateRow[]> {
  const rows = await tx
    .select()
    .from(rateTable)
    .where(inArray(rateTable.key, [...keys]));
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    unit: r.unit,
    nation: r.nation,
    validFrom: r.validFrom,
    validTo: r.validTo,
    tenantId: r.tenantId,
    verificationStatus: r.verificationStatus,
    source: r.source,
  }));
}

/**
 * The safety figures in force on a date. The classifier reads them for England only; outside
 * England only the falls figures (nation `all`) are used, by the post-fall checklist.
 */
export async function safetyRates(
  tx: Transaction,
  tenantId: string,
  on: string,
): Promise<SafetyRates> {
  return resolveSafetyRates(
    await rateRows(tx, Object.values(SAFETY_RATE_KEYS)),
    "england",
    on,
    tenantId,
  );
}

export async function dolsRates(
  tx: Transaction,
  tenantId: string,
  nation: DolsNation,
  on: string,
): Promise<DolsRates> {
  return resolveDolsRates(await rateRows(tx, Object.values(DOLS_RATE_KEYS)), nation, on, tenantId);
}

// ------------------------------------------------------------------------------------------------
// Statutory notification drafts
// ------------------------------------------------------------------------------------------------

/** Dates as ISO strings, so domain results can be stored as JSON and compared. */
export function toJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

export interface DraftSpec {
  readonly sourceKey: string;
  readonly kind: StatutoryNotificationKind;
  readonly locationId: string;
  readonly incidentId: string | null;
  readonly personId: string | null;
  readonly dolsAuthorisationId?: string | null;
  readonly dueAt: Date;
  readonly deadlines: readonly OutputDeadline[];
  readonly provisional: boolean;
  readonly reasons: readonly string[];
  readonly requiredContent: readonly string[];
  readonly sources: unknown;
  readonly statement?: unknown;
  readonly classifierVersion: string | null;
}

/**
 * Writes or refreshes a draft. A new draft starts the notification workflow and publishes
 * `safety.notification.due`; a draft or ready notification takes the latest clock and reasons;
 * a submitted or not-required one is never changed by the classifier.
 */
export async function upsertDraft(
  tx: Transaction,
  tenantId: string,
  spec: DraftSpec,
  now: Date,
): Promise<{ id: string; created: boolean }> {
  const [existing] = await tx
    .select()
    .from(statutoryNotification)
    .where(eq(statutoryNotification.sourceKey, spec.sourceKey))
    .for("update");
  const values = {
    dueAt: spec.dueAt,
    deadlines: toJson(spec.deadlines),
    provisional: spec.provisional,
    reasons: [...spec.reasons],
    requiredContent: [...spec.requiredContent],
    sources: toJson(spec.sources),
    statement: spec.statement === undefined ? null : toJson(spec.statement),
    classifierVersion: spec.classifierVersion,
  };
  if (!existing) {
    const [row] = await tx
      .insert(statutoryNotification)
      .values({
        ...values,
        sourceKey: spec.sourceKey,
        kind: spec.kind,
        locationId: spec.locationId,
        incidentId: spec.incidentId,
        personId: spec.personId,
        dolsAuthorisationId: spec.dolsAuthorisationId ?? null,
        retentionClass: NOTIFICATION_KINDS[spec.kind].retentionClass,
      })
      .returning({ id: statutoryNotification.id });
    if (!row) throw new Error("statutory notification was not created");
    await startWorkflow(
      tx,
      tenantId,
      STATUTORY_NOTIFICATION_WORKFLOW,
      { subjectType: "statutory_notification", subjectId: row.id, personId: spec.personId },
      now,
    );
    await publish(tx, {
      context: "safety",
      aggregateType: "statutory_notification",
      aggregateId: row.id,
      type: "safety.notification.due",
      payload: {
        notificationId: row.id,
        kind: spec.kind,
        dueAt: spec.dueAt.toISOString(),
        incidentId: spec.incidentId,
        provisional: spec.provisional,
      },
    });
    return { id: row.id, created: true };
  }
  if (existing.status === "draft" || existing.status === "ready") {
    const changed =
      existing.dueAt.getTime() !== spec.dueAt.getTime() ||
      existing.provisional !== spec.provisional ||
      existing.noLongerIndicated ||
      existing.classifierVersion !== spec.classifierVersion ||
      JSON.stringify(existing.deadlines) !== JSON.stringify(values.deadlines) ||
      JSON.stringify(existing.reasons) !== JSON.stringify(values.reasons) ||
      JSON.stringify(existing.statement) !== JSON.stringify(values.statement);
    if (changed) {
      await tx
        .update(statutoryNotification)
        .set({ ...values, noLongerIndicated: false, noLongerIndicatedReason: null })
        .where(eq(statutoryNotification.id, existing.id));
    }
  }
  return { id: existing.id, created: false };
}

// ------------------------------------------------------------------------------------------------
// The classifier's inputs
// ------------------------------------------------------------------------------------------------

const PERSON_KINDS = ["service_user", "worker", "other_not_at_work"] as const;

function isPressureCategory(value: string | null): value is PressureUlcerCategory {
  return (
    value === "category_1" ||
    value === "category_2" ||
    value === "category_3" ||
    value === "category_4" ||
    value === "unstageable" ||
    value === "deep_tissue_injury"
  );
}

/** Present pressure ulcer categories on the marks linked to an incident, per person (latest of each). */
async function pressureUlcersByPerson(
  tx: Transaction,
  incidentId: string,
  people: readonly IncidentPersonRow[],
): Promise<Map<string, PressureUlcerCategory[]>> {
  const personIds = people.flatMap((p) => (p.personId ? [p.personId] : []));
  if (personIds.length === 0) return new Map();
  const linked = people.flatMap((p) => p.bodyMapMarkIds);
  const columns = {
    id: bodyMapMark.id,
    personId: bodyMapMark.personId,
    pressureCategory: bodyMapMark.pressureCategory,
    status: bodyMapMark.status,
    supersedesId: bodyMapMark.supersedesId,
  };
  let marks = await tx
    .select(columns)
    .from(bodyMapMark)
    .where(
      and(
        inArray(bodyMapMark.personId, personIds),
        linked.length > 0
          ? or(eq(bodyMapMark.incidentId, incidentId), inArray(bodyMapMark.id, linked))
          : eq(bodyMapMark.incidentId, incidentId),
      ),
    );
  // Follow corrections and healing: a later mark that supersedes a linked one replaces it.
  for (let depth = 0; depth < 5 && marks.length > 0; depth++) {
    const known = new Set(marks.map((m) => m.id));
    const next = await tx
      .select(columns)
      .from(bodyMapMark)
      .where(
        inArray(
          bodyMapMark.supersedesId,
          marks.map((m) => m.id),
        ),
      );
    const fresh = next.filter((m) => !known.has(m.id));
    if (fresh.length === 0) break;
    marks = [...marks, ...fresh];
  }
  const superseded = new Set(marks.flatMap((m) => (m.supersedesId ? [m.supersedesId] : [])));
  const result = new Map<string, PressureUlcerCategory[]>();
  for (const m of marks) {
    if (superseded.has(m.id) || m.status !== "present") continue;
    if (!isPressureCategory(m.pressureCategory)) continue;
    result.set(m.personId, [...(result.get(m.personId) ?? []), m.pressureCategory]);
  }
  return result;
}

/** 18 or over on the UK date of the incident (LeDeR covers adults). */
function adultOn(dateOfBirth: string | null, on: string): boolean | undefined {
  if (!dateOfBirth) return undefined;
  const year = Number(dateOfBirth.slice(0, 4)) + 18;
  return `${year}${dateOfBirth.slice(4)}` <= on;
}

async function subjectToDolsAt(
  tx: Transaction,
  tenantId: string,
  personIds: readonly string[],
  at: Date,
): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const rows = await tx
    .select()
    .from(dolsAuthorisation)
    .where(
      and(
        inArray(dolsAuthorisation.personId, [...personIds]),
        eq(dolsAuthorisation.outcome, "granted"),
        isNull(dolsAuthorisation.deletedAt),
      ),
    );
  const subject = new Set<string>();
  const ratesByNation = new Map<DolsNation, DolsRates>();
  for (const row of rows) {
    const nation = row.nation as DolsNation;
    const rates =
      ratesByNation.get(nation) ?? (await dolsRates(tx, tenantId, nation, ukIsoDate(at)));
    ratesByNation.set(nation, rates);
    const status = dolsStatus(toDolsView(row), rates, at).status;
    if (status === "active" || status === "expiring") subject.add(row.personId);
  }
  return subject;
}

export function toDolsView(row: typeof dolsAuthorisation.$inferSelect) {
  const extensions = (
    row.extensions as { requestedAt: string; outcome: string; extendedTo: string | null }[]
  ).map((e) => ({
    requestedAt: new Date(e.requestedAt),
    outcome: e.outcome as "pending" | "granted" | "refused",
    extendedTo: e.extendedTo ? new Date(e.extendedTo) : null,
  }));
  return {
    id: row.id,
    type: row.type as "urgent" | "standard" | "court_order",
    nation: row.nation as DolsNation,
    requestedAt: row.requestedAt,
    outcome: row.outcome as "pending" | "granted" | "not_granted" | "withdrawn",
    outcomeAt: row.outcomeAt,
    grantedFrom: row.grantedFrom,
    grantedTo: row.grantedTo,
    extensions,
    precededByUrgent: row.precededByUrgent,
    withdrawalReason: row.withdrawalReason,
    endedAt: row.endedAt,
  };
}

/** The answers as the classifier reads them (the latest valid answer per key counts). */
export function toClassifierAnswers(
  rows: readonly (typeof classifierAnswer.$inferSelect)[],
): ClassifierAnswer[] {
  return rows.map((r) => ({
    key: r.questionKey as ClassifierQuestionKey,
    value: r.value as ClassifierAnswerValue,
    answeredAt: r.answeredAt,
    answeredBy: r.answeredBy ?? "",
  }));
}

/** The latest valid yes, no or not-sure answer to a question, or null when unanswered. */
function latestYesNoUnsure(
  answers: readonly ClassifierAnswer[],
  key: ClassifierQuestionKey,
): YesNoUnsure | null {
  const latest = [...answers]
    .filter((a) => a.key === key && classifierAnswerProblem(a.key, a.value) === null)
    .sort((a, b) => b.answeredAt.getTime() - a.answeredAt.getTime())[0];
  const value = latest?.value;
  return value === "yes" || value === "no" || value === "unsure" ? value : null;
}

/**
 * The infection cases at a location with symptoms that started after its last outbreak report was
 * decided (submitted or marked not required); outbreak.ts counts from there. Cases behind a draft
 * still being prepared keep counting, so the same threshold keeps the same draft.
 */
export async function locationInfectionCases(
  tx: Transaction,
  locationId: string,
): Promise<InfectionCase[]> {
  const [lastReport] = await tx
    .select({ decidedAt: statutoryNotification.updatedAt })
    .from(statutoryNotification)
    .where(
      and(
        eq(statutoryNotification.locationId, locationId),
        eq(statutoryNotification.kind, "ukhsa_outbreak"),
        inArray(statutoryNotification.status, ["submitted", "not_required"]),
        isNull(statutoryNotification.deletedAt),
      ),
    )
    .orderBy(desc(statutoryNotification.updatedAt))
    .limit(1);
  const rows = await tx
    .select({ id: incidentPerson.id, infection: incidentPerson.infection })
    .from(incidentPerson)
    .innerJoin(incident, eq(incident.id, incidentPerson.incidentId))
    .where(
      and(
        eq(incident.locationId, locationId),
        eq(incident.type, "ipc"),
        isNull(incident.deletedAt),
        isNull(incidentPerson.deletedAt),
        isNotNull(incidentPerson.infection),
      ),
    );
  const since = lastReport?.decidedAt.getTime() ?? Number.NEGATIVE_INFINITY;
  return rows
    .map((r) => {
      const i = r.infection as {
        syndrome: InfectionCase["syndrome"];
        onsetAt: string;
        couldBeLinkedWithinSetting: boolean | null;
        fluConfirmedAt?: string | null;
        link?: { group: string } | "not_linked" | null;
      };
      return {
        ref: r.id,
        syndrome: i.syndrome,
        onsetAt: new Date(i.onsetAt),
        couldBeLinkedWithinSetting: i.couldBeLinkedWithinSetting,
        fluConfirmedAt: i.fluConfirmedAt ? new Date(i.fluConfirmedAt) : null,
        link: i.link ?? null,
      } satisfies InfectionCase;
    })
    .filter((c) => c.onsetAt.getTime() > since);
}

const outbreakKey = (locationId: string, signal: OutbreakSignal) =>
  `outbreak:${locationId}:${signal.kind}:${signal.thresholdMetAt.toISOString()}`;

interface LoadedIncident {
  readonly row: IncidentRow;
  readonly people: readonly IncidentPersonRow[];
  readonly nation: IncidentNation;
  readonly facts: IncidentFacts;
  readonly answers: ClassifierAnswer[];
  readonly rates: SafetyRates;
  readonly outbreak: OutbreakAssessment | null;
}

async function loadIncident(
  tx: Transaction,
  tenantId: string,
  incidentId: string,
): Promise<LoadedIncident> {
  const [found] = await tx
    .select({ row: incident, nation: location.nation })
    .from(incident)
    .innerJoin(location, eq(location.id, incident.locationId))
    .where(eq(incident.id, incidentId));
  if (!found) throw new Error("incident not found for classification");
  const row = found.row;
  const people = await tx
    .select()
    .from(incidentPerson)
    .where(and(eq(incidentPerson.incidentId, incidentId), isNull(incidentPerson.deletedAt)));
  const serviceUserIds = people.flatMap((p) => (p.personId ? [p.personId] : []));
  const personRows =
    serviceUserIds.length === 0
      ? []
      : await tx
          .select({ id: person.id, dateOfBirth: person.dateOfBirth })
          .from(person)
          .where(inArray(person.id, serviceUserIds));
  const birth = new Map(personRows.map((p) => [p.id, p.dateOfBirth]));
  const occurredOn = ukIsoDate(row.occurredAt);
  const ulcers = await pressureUlcersByPerson(tx, incidentId, people);
  const underDols = await subjectToDolsAt(tx, tenantId, serviceUserIds, row.occurredAt);
  const factsPeople: IncidentPersonFacts[] = people.map((p) => {
    const kind = PERSON_KINDS.find((k) => k === p.kind) ?? "other_not_at_work";
    return {
      // Opaque ids only: the person's id, the staff member's id, or the row's own id.
      ref: p.personId ?? p.tenantUserId ?? p.id,
      kind,
      role: p.role as IncidentPersonFacts["role"],
      died: p.died,
      ...(p.learningDisability !== null ? { learningDisability: p.learningDisability } : {}),
      ...(p.autistic !== null ? { autistic: p.autistic } : {}),
      ...(p.personId
        ? (() => {
            const adult = adultOn(birth.get(p.personId) ?? null, occurredOn);
            return adult === undefined ? {} : { aged18OrOver: adult };
          })()
        : {}),
      subjectToDols: p.personId ? underDols.has(p.personId) : false,
      ...(p.subjectToMentalHealthAct !== null
        ? { subjectToMentalHealthAct: p.subjectToMentalHealthAct }
        : {}),
      pressureUlcers: p.personId ? (ulcers.get(p.personId) ?? []) : [],
    };
  });
  const facts: IncidentFacts = {
    type: row.type as IncidentType,
    occurredAt: row.occurredAt,
    foundAt: row.foundAt,
    nation: found.nation,
    people: factsPeople,
  };
  const answerRows = await tx
    .select()
    .from(classifierAnswer)
    .where(eq(classifierAnswer.incidentId, incidentId));
  const rates = await safetyRates(tx, tenantId, occurredOn);
  const outbreak =
    row.type === "ipc" && found.nation === "england"
      ? detectOutbreaks(await locationInfectionCases(tx, row.locationId), rates)
      : null;
  return {
    row,
    people,
    nation: found.nation,
    facts,
    answers: toClassifierAnswers(answerRows),
    rates,
    outbreak,
  };
}

// ------------------------------------------------------------------------------------------------
// Tasks (through the task engine)
// ------------------------------------------------------------------------------------------------

interface TaskSpec {
  readonly title: string;
  readonly permission: string;
  readonly urgent: boolean;
}

/** Generic titles only: the person is a reference on the task, never text in it. */
export const SAFETY_TASKS: Readonly<
  Record<ClassifierTaskKind | "post_fall_observation", TaskSpec>
> = {
  post_fall_injury_check: {
    title: "Check for injury after a fall",
    permission: "care.note.write",
    urgent: true,
  },
  urgent_medical_advice: {
    title: "Seek urgent medical advice after a fall",
    permission: "care.note.write",
    urgent: true,
  },
  post_fall_observations: {
    title: "Post-fall observations",
    permission: "care.note.write",
    urgent: true,
  },
  post_fall_observation: {
    title: "Post-fall observations",
    permission: "care.note.write",
    urgent: true,
  },
  post_fall_monitoring: {
    title: "Monitor after a fall",
    permission: "care.note.write",
    urgent: false,
  },
  gp_contact: { title: "Tell the GP about the fall", permission: "care.note.write", urgent: false },
  ng249_falls_pathway: {
    title: "Follow the falls pathway",
    permission: "care.assessment.write",
    urgent: false,
  },
  bone_health_review: {
    title: "Review bone health after a fall",
    permission: "care.plan.write",
    urgent: false,
  },
  answer_classifier_questions: {
    title: "Answer the notification questions",
    permission: "safety.incident.manage",
    urgent: true,
  },
  candour_threshold_decision: {
    title: "Record the duty of candour decision",
    permission: "safety.incident.manage",
    urgent: true,
  },
  safeguarding_decision_guide: {
    title: "Complete the safeguarding decision guide",
    permission: "safety.safeguarding.manage",
    urgent: true,
  },
  herbert_protocol_to_police: {
    title: "Give the police the Herbert Protocol profile",
    permission: "safety.incident.manage",
    urgent: true,
  },
  missing_person_search_log: {
    title: "Keep the missing person search log",
    permission: "safety.incident.manage",
    urgent: true,
  },
  return_welfare_check: {
    title: "Check welfare on return",
    permission: "care.note.write",
    urgent: false,
  },
  medical_examiner_pack: {
    title: "Assemble the medical examiner pack",
    permission: "safety.incident.manage",
    urgent: false,
  },
  riddor_absence_check: {
    title: "Check a worker's absence for RIDDOR",
    permission: "safety.incident.manage",
    urgent: false,
  },
  outbreak_link_review: {
    title: "Decide whether infection cases are linked",
    permission: "safety.incident.manage",
    urgent: false,
  },
};

const POST_FALL_KINDS: readonly PostFallTaskKind[] = [
  "post_fall_injury_check",
  "urgent_medical_advice",
  "post_fall_observations",
  "post_fall_monitoring",
  "gp_contact",
  "ng249_falls_pathway",
  "bone_health_review",
];

interface DesiredTask {
  readonly kind: keyof typeof SAFETY_TASKS;
  readonly personId: string | null;
  /** Null when the tenant's task defaults set the due time (stored as the time it was raised). */
  readonly dueAt: Date | null;
  readonly until: Date | null;
}

const taskKey = (kind: string, personId: string | null, dueAt: Date | null) =>
  `${kind}|${personId ?? ""}|${dueAt ? dueAt.toISOString() : "none"}`;

/**
 * The tasks an incident needs now: the classifier's, plus the post-fall checklist (every nation,
 * because it is a clinical checklist, not a statutory one) with one task per timed observation.
 */
function desiredTasks(loaded: LoadedIncident, result: ClassifierResult): DesiredTask[] {
  const serviceUsers = new Set(loaded.people.flatMap((p) => (p.personId ? [p.personId] : [])));
  const people = (refs: readonly string[]) => {
    const ids = refs.filter((r) => serviceUsers.has(r));
    return ids.length > 0 ? ids : [null];
  };
  const desired: DesiredTask[] = [];
  for (const t of result.tasks) {
    if ((POST_FALL_KINDS as readonly string[]).includes(t.task)) continue;
    for (const personId of people(t.personRefs)) {
      desired.push({ kind: t.task, personId, dueAt: t.dueAt, until: t.until ?? null });
    }
  }
  if (loaded.facts.type === "fall") {
    const checklist = postFallChecklist(
      {
        occurredAt: loaded.row.occurredAt,
        foundAt: loaded.row.foundAt,
        headInjury: latestYesNoUnsure(loaded.answers, "falls.head_injury"),
        anticoagulantOrAntiplatelet: latestYesNoUnsure(loaded.answers, "falls.anticoagulant"),
      },
      loaded.rates,
    );
    const affected = loaded.people.flatMap((p) =>
      p.personId && p.role === "affected" ? [p.personId] : [],
    );
    for (const personId of affected.length > 0 ? affected : [null]) {
      for (const t of checklist.tasks) {
        if (t.task === "post_fall_observations") {
          for (const at of checklist.observationTimes) {
            desired.push({ kind: "post_fall_observation", personId, dueAt: at, until: null });
          }
        } else {
          desired.push({ kind: t.task, personId, dueAt: t.dueAt, until: t.until ?? null });
        }
      }
    }
  }
  return desired;
}

/**
 * Creates the tasks an incident needs and closes the ones it no longer needs (an answer changed
 * the post-fall schedule, or every question is answered). Idempotent: a task already raised for
 * the same kind, person and time is never raised again, whatever its status.
 */
async function reconcileTasks(
  tx: Transaction,
  loaded: LoadedIncident,
  desired: readonly DesiredTask[],
  actorTenantUserId: string | null,
  now: Date,
): Promise<number> {
  const existing = await tx
    .select()
    .from(task)
    .where(
      and(
        eq(task.sourceType, "incident"),
        eq(task.sourceId, loaded.row.id),
        isNull(task.deletedAt),
      ),
    );
  const nullDue = new Set(desired.filter((d) => d.dueAt === null).map((d) => d.kind as string));
  const shortKind = (kind: string) =>
    kind.startsWith("safety.") ? kind.slice("safety.".length) : kind;
  const keyOf = (t: { kind: string; personId: string | null; dueAt: Date }) => {
    const kind = shortKind(t.kind);
    return taskKey(kind, t.personId, nullDue.has(kind) ? null : t.dueAt);
  };
  const existingKeys = new Set(existing.map(keyOf));
  const wanted = new Set(desired.map((d) => taskKey(d.kind, d.personId, d.dueAt)));
  for (const t of existing) {
    if (t.status !== "open" && t.status !== "in_progress") continue;
    if (wanted.has(keyOf(t))) continue;
    const answered = t.kind === "safety.answer_classifier_questions";
    await tx
      .update(task)
      .set(
        answered
          ? {
              status: "done",
              completedAt: now,
              completedBy: actorTenantUserId,
              statusReason: "Every notification question is answered",
            }
          : {
              status: "cancelled",
              statusReason: "No longer needed after the incident or its answers changed",
            },
      )
      .where(eq(task.id, t.id));
  }
  let created = 0;
  for (const d of desired) {
    const key = taskKey(d.kind, d.personId, d.dueAt);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    const spec = SAFETY_TASKS[d.kind];
    const dueAt = d.dueAt ?? now;
    await tx.insert(task).values({
      kind: `safety.${d.kind}`,
      title: spec.title,
      requiredPermission: spec.permission,
      personId: d.personId,
      locationId: loaded.row.locationId,
      sourceType: "incident",
      sourceId: loaded.row.id,
      dueAt,
      windowStart: d.until ? dueAt : null,
      windowEnd: d.until,
      priority: spec.urgent ? "urgent" : "routine",
    });
    created++;
  }
  return created;
}

// ------------------------------------------------------------------------------------------------
// Classify and store
// ------------------------------------------------------------------------------------------------

export interface ClassifyOutcome {
  readonly result: ClassifierResult;
  readonly classifiedAt: Date;
  readonly tasksCreated: number;
  readonly notificationsCreated: number;
}

/**
 * Runs the classifier on an incident and stores what it found (safety.md section 4; HZ-013): the
 * version, reasoning and open questions on the incident, the drafts with their clocks (from
 * `occurred_at`, never the sync time), drafts no longer indicated flagged for a person to decide,
 * and the tasks. Runs with tenant-wide scope so the classifier sees every person on the incident.
 */
export async function classifyAndStore(
  tx: Transaction,
  input: { tenantId: string; incidentId: string; actorTenantUserId: string | null; now: Date },
): Promise<ClassifyOutcome> {
  return withTenantWideScope(tx, async () => {
    const loaded = await loadIncident(tx, input.tenantId, input.incidentId);
    const [candour] = await tx
      .select({
        notifiable: candourRecord.thresholdNotifiable,
        decidedAt: candourRecord.thresholdDecidedAt,
      })
      .from(candourRecord)
      .where(eq(candourRecord.incidentId, input.incidentId));
    const result = classifyIncident({
      facts: loaded.facts,
      answers: loaded.answers,
      rates: loaded.rates,
      holidays: await bankHolidays(tx, loaded.nation),
      candourDecision:
        candour?.notifiable != null && candour.decidedAt
          ? { notifiable: candour.notifiable, decidedAt: candour.decidedAt }
          : null,
      outbreak: loaded.outbreak,
    });

    // The drafts.
    const serviceUsers = new Set(loaded.people.flatMap((p) => (p.personId ? [p.personId] : [])));
    const keys = new Set<string>();
    let notificationsCreated = 0;
    for (const output of result.outputs) {
      const perPerson = NOTIFICATION_KINDS[output.kind].per === "person";
      const people = perPerson ? output.personRefs.filter((r) => serviceUsers.has(r)) : [];
      const targets = people.length > 0 ? people : [null];
      for (const personId of targets) {
        const signal = output.kind === "ukhsa_outbreak" ? loaded.outbreak?.signals[0] : undefined;
        const sourceKey = signal
          ? outbreakKey(loaded.row.locationId, signal)
          : `incident:${loaded.row.id}:${output.kind}${personId ? `:${personId}` : ""}`;
        keys.add(sourceKey);
        const { created } = await upsertDraft(
          tx,
          input.tenantId,
          {
            sourceKey,
            kind: output.kind,
            locationId: loaded.row.locationId,
            incidentId: loaded.row.id,
            personId,
            dueAt: output.dueAt,
            deadlines: output.deadlines,
            provisional: output.provisional,
            reasons: output.reasons,
            requiredContent: output.requiredContent,
            sources: output.sources,
            classifierVersion: result.classifierVersion,
          },
          input.now,
        );
        if (created) notificationsCreated++;
      }
    }
    // Drafts the incident no longer needs stay drafts until a person marks them not required.
    const open = await tx
      .select()
      .from(statutoryNotification)
      .where(
        and(
          eq(statutoryNotification.incidentId, loaded.row.id),
          inArray(statutoryNotification.status, ["draft", "ready"]),
        ),
      );
    for (const n of open) {
      if (keys.has(n.sourceKey)) continue;
      const reason = noLongerIndicatedReason(result, n.kind as StatutoryNotificationKind);
      if (n.noLongerIndicated && n.noLongerIndicatedReason === reason) continue;
      await tx
        .update(statutoryNotification)
        .set({ noLongerIndicated: true, noLongerIndicatedReason: reason })
        .where(eq(statutoryNotification.id, n.id));
    }
    const anyNotification = await tx
      .select({ id: statutoryNotification.id })
      .from(statutoryNotification)
      .where(
        and(
          eq(statutoryNotification.incidentId, loaded.row.id),
          inArray(statutoryNotification.status, ["draft", "ready", "submitted"]),
        ),
      )
      .limit(1);

    await tx
      .update(incident)
      .set({
        classifierVersion: result.classifierVersion,
        classifiedAt: input.now,
        nationSupported: result.nationSupported,
        classifierResult: toJson(result),
        openQuestions: [...result.openQuestions],
        retentionClass:
          result.outputs.length > 0 || anyNotification.length > 0
            ? "serious_incident"
            : "care_record",
      })
      .where(eq(incident.id, loaded.row.id));

    const tasksCreated = await reconcileTasks(
      tx,
      loaded,
      desiredTasks(loaded, result),
      input.actorTenantUserId,
      input.now,
    );
    return { result, classifiedAt: input.now, tasksCreated, notificationsCreated };
  });
}

function noLongerIndicatedReason(
  result: ClassifierResult,
  kind: StatutoryNotificationKind,
): string {
  if (!result.nationSupported) return result.reasoning.join(" ");
  const excluded = result.exclusions.find((e) => e.kind === kind);
  if (excluded) return excluded.reason;
  const pending = result.pending.find((p) => p.kind === kind);
  if (pending) return `Waiting for answers: ${pending.waitingFor.join(", ")}.`;
  return "No longer found for this person or incident.";
}

// ------------------------------------------------------------------------------------------------
// DoLS outcome: the CQC regulation 18(4A) draft (HZ-020 with HZ-013)
// ------------------------------------------------------------------------------------------------

export async function draftDolsOutcomeNotification(
  tx: Transaction,
  tenantId: string,
  row: typeof dolsAuthorisation.$inferSelect,
  now: Date,
): Promise<{ required: boolean; reason: string; notificationId: string | null }> {
  const decision = dolsCqcNotification(toDolsView(row));
  if (!decision.required) return { required: false, reason: decision.reason, notificationId: null };
  const { id } = await upsertDraft(
    tx,
    tenantId,
    {
      sourceKey: `dols:${row.id}`,
      kind: decision.kind,
      locationId: row.locationId,
      incidentId: null,
      personId: row.personId,
      dolsAuthorisationId: row.id,
      dueAt: decision.dueAt,
      deadlines: [
        { key: "without_delay", dueAt: decision.dueAt, wording: decision.reason, statutory: true },
      ],
      provisional: false,
      reasons: [decision.reason],
      requiredContent: [],
      sources: decision.sources,
      statement: decision.statement,
      classifierVersion: null,
    },
    now,
  );
  return { required: true, reason: decision.reason, notificationId: id };
}

// ------------------------------------------------------------------------------------------------
// Escalation of overdue drafts (safety.md rule 10)
// ------------------------------------------------------------------------------------------------

export const OVERDUE_CHAIN_KEY = "safety.notification.overdue";
export const OVERDUE_ESCALATION_RATE_KEY = "statutory_notification.escalation_minutes";

/**
 * The tenant's escalation chain for overdue statutory notifications. A tenant that has not set one
 * gets the default: the Nominated Individual (the owner role) after the rate table's minutes.
 */
async function overdueChain(tx: Transaction, tenantId: string) {
  const [existing] = await tx
    .select()
    .from(escalationChain)
    .where(and(eq(escalationChain.key, OVERDUE_CHAIN_KEY), isNull(escalationChain.deletedAt)));
  if (existing) return existing;
  const minutes = await rateNumber(tx, tenantId, OVERDUE_ESCALATION_RATE_KEY);
  const steps: EscalationStep[] = [
    { afterMinutes: minutes, targetRoleKey: "owner", channels: ["in_app", "email"] },
  ];
  const [created] = await tx
    .insert(escalationChain)
    .values({
      key: OVERDUE_CHAIN_KEY,
      name: "Overdue statutory notification",
      steps,
    })
    .returning();
  if (!created) throw new Error("escalation chain was not created");
  return created;
}

/** Who may submit at a location: role holders and current acting-up grants. */
export async function submitHolders(
  tx: Transaction,
  locationId: string,
  now: Date,
): Promise<string[]> {
  const holders = await tx
    .selectDistinct({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        sql`${role.permissions} @> ARRAY['safety.notification.submit']::text[]`,
        isNull(roleAssignment.deletedAt),
        isNull(role.archivedAt),
        lte(roleAssignment.validFrom, now),
        or(isNull(roleAssignment.validTo), sql`${roleAssignment.validTo} > ${now}`),
        or(isNull(roleAssignment.locationId), eq(roleAssignment.locationId, locationId)),
      ),
    );
  const grants = await tx
    .selectDistinct({ id: accessGrant.tenantUserId })
    .from(accessGrant)
    .where(
      and(
        sql`${accessGrant.permissions} @> ARRAY['safety.notification.submit']::text[]`,
        isNull(accessGrant.deletedAt),
        isNull(accessGrant.revokedAt),
        lte(accessGrant.validFrom, now),
        sql`${accessGrant.validTo} > ${now}`,
        or(isNull(accessGrant.locationId), eq(accessGrant.locationId, locationId)),
      ),
    );
  return [...new Set([...holders, ...grants].map((h) => h.id))];
}

/**
 * Tells the holders of `safety.notification.submit` once about each overdue draft, through the
 * tenant's escalation chain, and publishes `safety.notification.overdue`. The chain carries on
 * until the notification is submitted or marked not required (which acknowledges the alerts).
 */
export async function escalateOverdueNotifications(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const overdue: NotificationRow[] = await tx
    .select()
    .from(statutoryNotification)
    .where(
      and(
        inArray(statutoryNotification.status, ["draft", "ready"]),
        lte(statutoryNotification.dueAt, now),
        isNull(statutoryNotification.overdueNotifiedAt),
        isNull(statutoryNotification.deletedAt),
      ),
    )
    .limit(500);
  if (overdue.length === 0) return 0;
  const chain = await overdueChain(tx, tenantId);
  const steps = chain.steps as EscalationStep[];
  for (const n of overdue) {
    for (const recipient of await submitHolders(tx, n.locationId, now)) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: recipient,
          kind: "safety.notification.overdue",
          severity: "urgent",
          title: "A statutory notification is overdue",
          body: "Open it to submit it, or to record why it is not required.",
          link: `/notifications/statutory/${n.id}`,
          channels: ["in_app", "push"],
          sourceType: "statutory_notification",
          sourceId: n.id,
          dedupeKey: `statutory_overdue:${n.id}`,
          escalationChainId: chain.id,
          escalateAt: nextEscalationAt(steps, {
            createdAt: now,
            stepsFired: 0,
            acknowledgedAt: null,
          }),
        })
        .onConflictDoNothing();
    }
    await tx
      .update(statutoryNotification)
      .set({ overdueNotifiedAt: now })
      .where(eq(statutoryNotification.id, n.id));
    await publish(tx, {
      context: "safety",
      aggregateType: "statutory_notification",
      aggregateId: n.id,
      type: "safety.notification.overdue",
      payload: { notificationId: n.id, kind: n.kind, dueAt: n.dueAt.toISOString() },
    });
  }
  return overdue.length;
}

/** Stops the escalation chain once a notification is submitted or marked not required. */
export async function acknowledgeOverdueAlerts(
  tx: Transaction,
  notificationId: string,
  now: Date,
): Promise<void> {
  await withTenantWideScope(tx, async () => {
    await tx
      .update(notification)
      .set({ acknowledgedAt: now, escalateAt: null })
      .where(
        and(
          eq(notification.sourceType, "statutory_notification"),
          eq(notification.sourceId, notificationId),
          isNull(notification.acknowledgedAt),
        ),
      );
  });
}

// ------------------------------------------------------------------------------------------------
// Worker sweeps
// ------------------------------------------------------------------------------------------------

/**
 * Outbreak detection across each location's infection cases (safety.md rule 7): the latest
 * infection incident at the location is classified again with the location's cases, which drafts
 * the UKHSA report once a threshold is met (one draft per threshold, by its source key).
 */
export async function detectLocationOutbreaks(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const locations = await tx
    .selectDistinct({ id: incident.locationId })
    .from(incident)
    .innerJoin(location, eq(location.id, incident.locationId))
    .where(
      and(eq(incident.type, "ipc"), isNull(incident.deletedAt), eq(location.nation, "england")),
    );
  let drafted = 0;
  for (const { id: locationId } of locations) {
    const [latest] = await tx
      .select({ id: incident.id })
      .from(incident)
      .where(
        and(
          eq(incident.locationId, locationId),
          eq(incident.type, "ipc"),
          isNull(incident.deletedAt),
        ),
      )
      .orderBy(sql`${incident.status} = 'closed'`, desc(incident.occurredAt))
      .limit(1);
    if (!latest) continue;
    const outcome = await classifyAndStore(tx, {
      tenantId,
      incidentId: latest.id,
      actorTenantUserId: null,
      now,
    });
    drafted += outcome.notificationsCreated;
  }
  return drafted;
}

/** Whether a DoLS nation string is one Schedule A1 covers. */
export function isDolsNation(nation: string): nation is DolsNation {
  return (DOLS_NATIONS as readonly string[]).includes(nation);
}
