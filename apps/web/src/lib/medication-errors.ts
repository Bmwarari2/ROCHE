import type { components } from "@harbour/contracts/client";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import {
  CalendarCheck,
  CalendarClock,
  CircleCheck,
  CircleHelp,
  Clock,
  Landmark,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  TriangleAlert,
  Users,
} from "lucide-react";
import { isUuid } from "./context-cookies";
import { type FormWithAll, medicinesHref, type Read } from "./medicines";
import { isIsoDate, readDateField, readDateTimeField, ukToday } from "./uk-time";

/**
 * Medication errors, medication reviews and the medicines reports on the web (slice 55; MEDS-012,
 * MEDS-013; medicines.md section 14; HZ-134). Pure helpers for the pages and forms. The API runs
 * every rule again (`checkMedicationErrorRecord`, `checkReviewDone`) and answers in words; these
 * read the forms so a mistake is said at its field first. Nothing here scores, judges or
 * recommends: the escalations are the API's own words, shown and never sent, and the reports are
 * counts of records for a person to read.
 */

type Schemas = components["schemas"];
export type MedicationError = NonNullable<Schemas["MedicationErrorOut"]>;
export type NewMedicationErrorBody = Schemas["NewMedicationError"];
export type EditMedicationErrorBody = Schemas["EditMedicationError"];
export type ErrorKind = NonNullable<Schemas["MedicationErrorKind"]>;
export type ErrorStage = NonNullable<Schemas["MedicationErrorStage"]>;
export type ErrorAnswer = NonNullable<Schemas["MedicationErrorAnswer"]>;
export type ErrorPrompt = Schemas["MedicationErrorPrompt"];
export type Review = Schemas["MedicationReviewOut"];
export type ReviewerRole = NonNullable<Schemas["ReviewerRole"]>;
export type ReviewStatus = Schemas["ReviewStatus"];
export type TrackerLine = Schemas["ReviewTrackerLine"];
export type ScheduleReviewBody = Schemas["ScheduleMedicationReview"];
export type ReviewDoneBody = Schemas["RecordMedicationReview"];
export type RescheduleReviewBody = Schemas["ChangeMedicationReview"];
export type CancelReviewBody = Schemas["CancelMedicationReview"];
/** One change to a review, as the person's reviews page sends it. */
export type ReviewChange =
  | { readonly kind: "done"; readonly body: ReviewDoneBody }
  | { readonly kind: "reschedule"; readonly body: RescheduleReviewBody }
  | { readonly kind: "cancel"; readonly body: CancelReviewBody };
export type ErrorTrend = Schemas["MedicationErrorTrend"];
export type OverrideReport = Schemas["OverrideReport"];
export type UsageReport = Schemas["UsageReport"];

/** Reading an incident's medication error (the API adds MFA and the incident's own scope). */
export const ERROR_READ = "safety.incident.read";
/** Adding and changing it (the API adds: its raiser, a manager there, or who added it). */
export const ERROR_REPORT = "safety.incident.report";
/** Medication reviews, the tracker and the reports (the reports at the location only). */
export const REVIEWS_MANAGE = "medicines.record.manage";

export const errorRecordShown = (permissions: readonly string[]) =>
  permissions.includes(ERROR_READ);
export const errorRecordWritable = (permissions: readonly string[]) =>
  permissions.includes(ERROR_REPORT);
export const reviewsShown = (permissions: readonly string[]) =>
  permissions.includes(REVIEWS_MANAGE);

export const medicationErrorHref = (incidentId: string) =>
  `/incidents/${incidentId}/medication-error`;
export const personReviewsHref = (personId: string) => `${medicinesHref(personId)}/reviews`;
export const REPORTS_HREF = "/medicines-reports";
export const reportsHref = (locationId: string) => `${REPORTS_HREF}/${locationId}`;
export type ReportName = "reviews" | "overrides" | "prn" | "trend";
export const REPORT_NAMES: readonly ReportName[] = ["reviews", "overrides", "prn", "trend"];
export const reportHref = (locationId: string, report: ReportName) =>
  `${reportsHref(locationId)}/${report}`;

/** The kinds in the order the contract lists them (the NRLS categories, as Harbour adapts them). */
export const ERROR_KINDS: readonly ErrorKind[] = [
  "omitted_dose",
  "wrong_dose",
  "wrong_medicine",
  "wrong_person",
  "wrong_time",
  "wrong_route",
  "given_after_stopped",
  "wrong_frequency",
  "wrong_formulation",
  "wrong_quantity",
  "allergy_or_contraindication",
  "expired_medicine",
  "wrong_storage",
  "monitoring_not_done",
  "record_unclear_or_missing",
  "other",
];
export const ERROR_STAGES: readonly ErrorStage[] = [
  "prescribing",
  "transcribing",
  "dispensing",
  "administration",
  "monitoring",
  "storage",
  "other",
];
export const ANSWERS: readonly ErrorAnswer[] = ["yes", "no", "unsure"];
export const REVIEWER_ROLES: readonly ReviewerRole[] = [
  "gp",
  "pharmacist",
  "prescriber",
  "consultant",
  "other",
];

/** The longest answers the API takes (the contract's `words(n)`). */
export const ERROR_TEXT_MAX = 2000;
export const CD_REFERENCE_MAX = 120;
export const CLINICIAN_NAME_MAX = 200;
export const OUTCOME_MAX = 4000;
export const REASON_MAX = 500;

type Chip = {
  readonly status: StatusChipStatus;
  readonly icon: LucideIcon;
  readonly label: string;
};

/**
 * An escalation the API returned, as an icon and its name (never colour alone). Every one but the
 * CQC reminder is something still to do, so it shows as due; the reminder is information only.
 */
export function promptChip(prompt: ErrorPrompt["prompt"], t: Translator): Chip {
  const label = t("medicines.errors.prompt", { prompt });
  switch (prompt) {
    case "clinical_advice":
      return { status: "due", icon: Stethoscope, label };
    case "controlled_drug_report":
      return { status: "due", icon: ShieldAlert, label };
    case "safeguarding_consideration":
      return { status: "due", icon: Users, label };
    case "cqc_through_classifier":
      return { status: "info", icon: Landmark, label };
  }
}

/**
 * Whether it reached the person, in words: an error, a near miss, or not yet known. The API decides
 * (`nearMiss`; an omitted dose is never a near miss, HZ-003); this only says it.
 */
export function reachedChip(nearMiss: boolean | null, t: Translator): Chip {
  if (nearMiss === null)
    return {
      status: "notRecorded",
      icon: CircleHelp,
      label: t("medicines.errors.reached", { state: "unknown" }),
    };
  return nearMiss
    ? {
        status: "info",
        icon: ShieldCheck,
        label: t("medicines.errors.reached", { state: "near_miss" }),
      }
    : {
        status: "overdue",
        icon: TriangleAlert,
        label: t("medicines.errors.reached", { state: "reached" }),
      };
}

/** A tracker line's status as an icon and the API's words (never colour alone; HZ-134). */
export function reviewChip(status: ReviewStatus, words: string): Chip {
  switch (status) {
    case "overdue":
      return { status: "overdue", icon: TriangleAlert, label: words };
    case "due_soon":
      return { status: "due", icon: Clock, label: words };
    case "scheduled":
      return { status: "done", icon: CalendarCheck, label: words };
    case "not_booked":
      return { status: "due", icon: CalendarClock, label: words };
    case "not_scheduled":
      return { status: "notRecorded", icon: CircleHelp, label: words };
  }
}

/** One review on a person's list: done, or booked and not yet done (cancelled ones are not listed). */
export function reviewEntryChip(review: Pick<Review, "doneOn">, t: Translator): Chip {
  return review.doneOn
    ? {
        status: "done",
        icon: CircleCheck,
        label: t("medicines.errors.review.state", { state: "done" }),
      }
    : {
        status: "due",
        icon: CalendarClock,
        label: t("medicines.errors.review.state", { state: "booked" }),
      };
}

// ---------------------------------------------------------------------------------------------
// Reading the forms

const text = (form: FormWithAll, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const optional = (form: FormWithAll, name: string) => text(form, name) || null;

function choice<T extends string>(
  form: FormWithAll,
  name: string,
  allowed: readonly T[],
): T | null | "invalid" {
  const value = text(form, name);
  if (!value) return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : "invalid";
}

/** An id chosen from a list: empty is none; anything but a UUID is refused. */
function chosenId(form: FormWithAll, name: string): string | null | "invalid" {
  const value = text(form, name);
  if (!value) return null;
  return isUuid(value) ? value : "invalid";
}

type Errors = Record<string, string>;

export interface ErrorFormContext {
  /** When the incident happened: the clinician cannot have been told before it. */
  readonly occurredAt: string | null;
  /** This device's clock. */
  readonly now?: Date;
}

type ErrorFields = Omit<NewMedicationErrorBody, "personId">;

/**
 * The details shared by adding and changing a record. Mirrors `checkMedicationErrorRecord`, so each
 * problem shows at its field; the API checks again, including the controlled drug presumed from the
 * medicine's schedule, which the web does not know.
 */
function readErrorFields(
  form: FormWithAll,
  t: Translator,
  context: ErrorFormContext,
  errors: Errors,
): ErrorFields | null {
  const now = context.now ?? new Date();
  const medicationId = chosenId(form, "medicationId");
  if (medicationId === "invalid") errors.medicationId = t("medicines.errors.form.medicineError");
  const administrationId = chosenId(form, "administrationId");
  if (administrationId === "invalid")
    errors.administrationId = t("medicines.errors.form.doseRecordError");

  const typedKinds = form.getAll("kinds").filter((k): k is string => typeof k === "string");
  if (typedKinds.some((k) => !(ERROR_KINDS as readonly string[]).includes(k)))
    errors.kinds = t("medicines.errors.form.kindsError");
  const kinds = [...new Set(typedKinds)].filter((k): k is ErrorKind =>
    (ERROR_KINDS as readonly string[]).includes(k),
  );

  const stage = choice(form, "stage", ERROR_STAGES);
  if (stage === "invalid") errors.stage = t("medicines.errors.form.stageError");
  const reachedPerson = choice(form, "reachedPerson", ANSWERS);
  const controlledDrug = choice(form, "controlledDrug", ANSWERS);
  const deliberateOrRepeated = choice(form, "deliberateOrRepeated", ANSWERS);
  for (const [name, value] of [
    ["reachedPerson", reachedPerson],
    ["controlledDrug", controlledDrug],
    ["deliberateOrRepeated", deliberateOrRepeated],
  ] as const) {
    if (value === "invalid") errors[name] = t("medicines.errors.form.answerError");
  }
  if (kinds.includes("omitted_dose") && reachedPerson === "no")
    errors.reachedPerson = t("medicines.errors.form.omittedNotReached");

  const immediateActions = optional(form, "immediateActions");
  const clinicianTold = optional(form, "clinicianTold");
  const adviceGiven = optional(form, "adviceGiven");
  const rootCause = optional(form, "rootCause");
  for (const [name, value] of [
    ["immediateActions", immediateActions],
    ["clinicianTold", clinicianTold],
    ["adviceGiven", adviceGiven],
    ["rootCause", rootCause],
  ] as const) {
    if (value !== null && value.length > ERROR_TEXT_MAX)
      errors[name] = t("medicines.errors.form.tooLong", { max: ERROR_TEXT_MAX });
  }

  const toldAt = readDateTimeField(form, "clinicianToldAt", {
    subject: t("medicines.errors.form.clinicianToldAtSubject"),
    optional: true,
    t,
    now,
  });
  if (!toldAt.ok) errors.clinicianToldAt = toldAt.message;
  const clinicianToldAt = toldAt.ok ? toldAt.instant : null;
  if (toldAt.ok && (clinicianToldAt === null) !== (clinicianTold === null)) {
    errors[clinicianToldAt === null ? "clinicianToldAt" : "clinicianTold"] = t(
      "medicines.errors.form.clinicianIncomplete",
    );
  }
  if (
    clinicianToldAt !== null &&
    context.occurredAt !== null &&
    Date.parse(clinicianToldAt) < Date.parse(context.occurredAt)
  )
    errors.clinicianToldAt = t("medicines.errors.form.toldBeforeIncident");

  const reported = readDateField(form, "cdReportedOn", {
    subject: t("medicines.errors.form.cdReportedOnSubject"),
    optional: true,
    t,
  });
  if (!reported.ok) errors.cdReportedOn = reported.message;
  const cdReportedOn = reported.ok ? reported.date : null;
  const cdReportReference = optional(form, "cdReportReference");
  if (cdReportReference !== null && cdReportReference.length > CD_REFERENCE_MAX)
    errors.cdReportReference = t("medicines.errors.form.tooLong", { max: CD_REFERENCE_MAX });
  if (reported.ok && (cdReportedOn === null) !== (cdReportReference === null)) {
    errors[cdReportedOn === null ? "cdReportedOn" : "cdReportReference"] = t(
      "medicines.errors.form.cdIncomplete",
    );
  }
  if (cdReportedOn !== null && cdReportedOn > ukToday(now))
    errors.cdReportedOn = t("medicines.errors.form.cdInFuture");
  if (cdReportedOn !== null && controlledDrug === "no")
    errors.controlledDrug = t("medicines.errors.form.cdReportWithoutCd");

  if (Object.keys(errors).length > 0) return null;
  return {
    medicationId: medicationId as string | null,
    administrationId: administrationId as string | null,
    kinds,
    stage: stage as ErrorStage | null,
    reachedPerson: reachedPerson as ErrorAnswer | null,
    controlledDrug: controlledDrug as ErrorAnswer | null,
    deliberateOrRepeated: deliberateOrRepeated as ErrorAnswer | null,
    immediateActions,
    clinicianToldAt,
    clinicianTold,
    adviceGiven,
    rootCause,
    cdReportedOn,
    cdReportReference,
  };
}

/** Adding the record: about one of the people on the incident (`personIds`), then the details. */
export function readNewMedicationError(
  form: FormWithAll,
  t: Translator,
  context: ErrorFormContext & { readonly personIds: readonly string[] },
): Read<NewMedicationErrorBody> {
  const errors: Errors = {};
  const personId = text(form, "personId");
  if (!context.personIds.includes(personId))
    errors.personId = t("medicines.errors.form.personError");
  const fields = readErrorFields(form, t, context, errors);
  if (!fields || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { personId, ...fields } };
}

/** Changing the record: the details, with the version read. */
export function readEditMedicationError(
  form: FormWithAll,
  t: Translator,
  context: ErrorFormContext & { readonly version: number },
): Read<EditMedicationErrorBody> {
  const errors: Errors = {};
  const fields = readErrorFields(form, t, context, errors);
  if (!fields) return { ok: false, errors };
  return { ok: true, body: { ...fields, version: context.version } };
}

function requiredDate(
  form: FormWithAll,
  name: string,
  subject: string,
  t: Translator,
  errors: Errors,
): string | null {
  const read = readDateField(form, name, { subject, t });
  if (!read.ok) {
    errors[name] = read.message;
    return null;
  }
  return read.date;
}

function reason(form: FormWithAll, t: Translator, errors: Errors, name = "reason"): string {
  const value = text(form, name);
  if (!value) errors[name] = t("medicines.errors.review.reasonError");
  else if (value.length > REASON_MAX)
    errors[name] = t("medicines.errors.form.tooLong", { max: REASON_MAX });
  return value;
}

/** Scheduling a review: the date it is due. */
export function readScheduleReview(form: FormWithAll, t: Translator): Read<ScheduleReviewBody> {
  const errors: Errors = {};
  const dueOn = requiredDate(form, "dueOn", t("medicines.errors.review.dueOnSubject"), t, errors);
  if (!dueOn) return { ok: false, errors };
  return { ok: true, body: { dueOn } };
}

/**
 * A review done: the date (not in the future), the clinician's name and role and the outcome in the
 * clinician's words. Changing one already done is a correction and needs a reason.
 */
export function readReviewDone(
  form: FormWithAll,
  t: Translator,
  context: { readonly version: number; readonly correcting: boolean; readonly now?: Date },
): Read<ReviewDoneBody> {
  const errors: Errors = {};
  const doneOn = requiredDate(
    form,
    "doneOn",
    t("medicines.errors.review.doneOnSubject"),
    t,
    errors,
  );
  if (doneOn && doneOn > ukToday(context.now ?? new Date()))
    errors.doneOn = t("medicines.errors.review.doneInFuture");
  const clinicianName = text(form, "clinicianName");
  if (!clinicianName) errors.clinicianName = t("medicines.errors.review.clinicianError");
  else if (clinicianName.length > CLINICIAN_NAME_MAX)
    errors.clinicianName = t("medicines.errors.form.tooLong", { max: CLINICIAN_NAME_MAX });
  const role = choice(form, "clinicianRole", REVIEWER_ROLES);
  if (role === null || role === "invalid")
    errors.clinicianRole = t("medicines.errors.review.roleError");
  const outcome = text(form, "outcome");
  if (!outcome) errors.outcome = t("medicines.errors.review.outcomeError");
  else if (outcome.length > OUTCOME_MAX)
    errors.outcome = t("medicines.errors.form.tooLong", { max: OUTCOME_MAX });
  const correctionReason = context.correcting ? reason(form, t, errors, "correctionReason") : null;
  if (Object.keys(errors).length > 0 || !doneOn) return { ok: false, errors };
  return {
    ok: true,
    body: {
      doneOn,
      clinicianName,
      clinicianRole: role as ReviewerRole,
      outcome,
      correctionReason,
      version: context.version,
    },
  };
}

/** Moving a booked review to another date, with a reason. */
export function readRescheduleReview(
  form: FormWithAll,
  t: Translator,
  version: number,
): Read<RescheduleReviewBody> {
  const errors: Errors = {};
  const dueOn = requiredDate(
    form,
    "dueOn",
    t("medicines.errors.review.newDueOnSubject"),
    t,
    errors,
  );
  const why = reason(form, t, errors);
  if (Object.keys(errors).length > 0 || !dueOn) return { ok: false, errors };
  return { ok: true, body: { dueOn, reason: why, version } };
}

/** Cancelling a booked review, with a reason; it stays in the history. */
export function readCancelReview(
  form: FormWithAll,
  t: Translator,
  version: number,
): Read<CancelReviewBody> {
  const errors: Errors = {};
  const why = reason(form, t, errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { reason: why, version } };
}

// ---------------------------------------------------------------------------------------------
// The API's refusals at their fields

/** Which field each medication error problem (the domain's code) is about; null: above the form. */
export const ERROR_FIELD_FOR_PROBLEM: Readonly<Record<string, string | null>> = {
  kind_unknown: "kinds",
  kinds_repeated: "kinds",
  text_too_long: null,
  clinician_incomplete: "clinicianTold",
  clinician_told_in_future: "clinicianToldAt",
  clinician_told_before_incident: "clinicianToldAt",
  cd_report_incomplete: "cdReportReference",
  cd_report_in_future: "cdReportedOn",
  reference_too_long: "cdReportReference",
  omitted_not_reached: "reachedPerson",
  cd_denied_for_scheduled: "controlledDrug",
  cd_report_without_cd: "controlledDrug",
};

/** Which field each review problem is about. */
export const REVIEW_FIELD_FOR_PROBLEM: Readonly<Record<string, string | null>> = {
  due_not_a_date: "dueOn",
  done_not_a_date: "doneOn",
  done_in_future: "doneOn",
  clinician_required: "clinicianName",
  role_unknown: "clinicianRole",
  outcome_required: "outcome",
  text_too_long: null,
};

/**
 * The API joins every problem's sentence into one refusal; this finds each known sentence in it and
 * puts it at its field, so the API's own words show beside what they are about.
 */
export function fieldsFromRefusal(
  detail: string,
  words: Readonly<Record<string, string>>,
  fieldFor: Readonly<Record<string, string | null>>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [problem, sentence] of Object.entries(words)) {
    const field = fieldFor[problem];
    if (field && detail.includes(sentence)) fields[field] ??= sentence;
  }
  return fields;
}

// ---------------------------------------------------------------------------------------------
// Report periods and tables

export interface Period {
  readonly from: string;
  readonly to: string;
}

/** The default period: the `days` up to and including today, in UK dates. */
export function defaultPeriod(days: number, now: Date = new Date()): Period {
  const to = ukToday(now);
  const end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - (days - 1));
  return { from: end.toISOString().slice(0, 10), to };
}

/** The default trend period: the first of the month five months ago to today (six months). */
export function defaultTrendPeriod(now: Date = new Date()): Period {
  const to = ukToday(now);
  const [y, m] = to.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1 - 5, 1));
  return { from: start.toISOString().slice(0, 10), to };
}

type Params = Readonly<Record<string, string | string[] | undefined>>;
const param = (params: Params, name: string) => {
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
};

/**
 * The report period from the page's address: the date boxes the period form sends (`from-day`...),
 * or `from` and `to` as dates, or the default. A date that is not real, or an end before the
 * start, is said at its field and nothing is read. The API caps the length in its own words.
 */
export function readPeriod(
  params: Params,
  t: Translator,
  fallback: Period,
):
  | { readonly ok: true; readonly period: Period }
  | { readonly ok: false; readonly errors: Readonly<Errors>; readonly period: Period } {
  const boxes = ["from", "to"].some((name) =>
    ["day", "month", "year"].some((part) => param(params, `${name}-${part}`) !== ""),
  );
  if (!boxes) {
    const from = param(params, "from");
    const to = param(params, "to");
    if (from === "" && to === "") return { ok: true, period: fallback };
    const errors: Errors = {};
    if (!isIsoDate(from)) errors.from = t("medicines.errors.period.fromError");
    if (!isIsoDate(to)) errors.to = t("medicines.errors.period.toError");
    if (Object.keys(errors).length > 0) return { ok: false, errors, period: fallback };
    if (to < from)
      return {
        ok: false,
        errors: { to: t("medicines.errors.period.order") },
        period: { from, to },
      };
    return { ok: true, period: { from, to } };
  }
  const form = { get: (name: string) => param(params, name) };
  const errors: Errors = {};
  const from = readDateField(form, "from", { subject: t("medicines.errors.period.from"), t });
  const to = readDateField(form, "to", { subject: t("medicines.errors.period.to"), t });
  if (!from.ok) errors.from = from.message;
  if (!to.ok) errors.to = to.message;
  if (!from.ok || !to.ok || !from.date || !to.date) return { ok: false, errors, period: fallback };
  if (to.date < from.date)
    return {
      ok: false,
      errors: { to: t("medicines.errors.period.order") },
      period: { from: from.date, to: to.date },
    };
  return { ok: true, period: { from: from.date, to: to.date } };
}

/** "2026-11" as "November 2026", in the catalogue's words. */
export function monthWords(month: string, t: Translator): string {
  const [year, m] = month.split("-");
  return t("safety.trends.month", { month: Number(m), year: year ?? "" });
}

export interface TableRow {
  readonly id: string;
  readonly label: string;
  readonly cells: readonly string[];
}

/**
 * The trend as three tables, every month a column (an empty month is zero, never missing): whether
 * it reached the person, the kinds, and the stages. A kind or stage with no record in the period is
 * left out, so the table lists only what happened; the totals column sums each row.
 */
export function trendTables(
  trend: Pick<ErrorTrend, "months">,
  t: Translator,
): {
  readonly months: readonly string[];
  readonly reached: readonly TableRow[];
  readonly kinds: readonly TableRow[];
  readonly stages: readonly TableRow[];
} {
  const months = trend.months.map((m) => monthWords(m.month, t));
  const row = (id: string, label: string, counts: readonly number[]): TableRow => ({
    id,
    label,
    cells: [...counts.map(String), String(counts.reduce((a, b) => a + b, 0))],
  });
  const reached = [
    row(
      "errors",
      t("medicines.errors.trend.row", { row: "errors" }),
      trend.months.map((m) => m.errors),
    ),
    row(
      "nearMisses",
      t("medicines.errors.trend.row", { row: "nearMisses" }),
      trend.months.map((m) => m.nearMisses),
    ),
    row(
      "notYetKnown",
      t("medicines.errors.trend.row", { row: "notYetKnown" }),
      trend.months.map((m) => m.notYetKnown),
    ),
  ];
  const by = <K extends string>(
    keys: readonly K[],
    pick: (m: ErrorTrend["months"][number]) => Readonly<Record<string, number>>,
    label: (key: K) => string,
  ) =>
    keys
      .map((key) =>
        row(
          key,
          label(key),
          trend.months.map((m) => pick(m)[key] ?? 0),
        ),
      )
      .filter((r) => r.cells.at(-1) !== "0");
  return {
    months,
    reached,
    kinds: by(
      ERROR_KINDS,
      (m) => m.byKind,
      (kind) => t("medicines.errors.kind", { kind }),
    ),
    stages: by(
      ERROR_STAGES,
      (m) => m.byStage,
      (stage) => t("medicines.errors.stage", { stage }),
    ),
  };
}

/** The override report's rows: each member's three counts, a member without a name said so. */
export function overrideRows(report: Pick<OverrideReport, "items">, t: Translator): TableRow[] {
  return report.items.map((item) => ({
    id: item.memberId,
    label: item.name ?? t("medicines.errors.overrides.unnamed"),
    cells: [
      String(item.competenceOverride),
      String(item.competenceNotCurrent),
      String(item.givenBeforeRecorded),
    ],
  }));
}

/** The PRN report's rows: per person, then each medicine under them, with its counts. */
export function usageRows(report: Pick<UsageReport, "items">, t: Translator): TableRow[] {
  return report.items.flatMap((person) => [
    {
      id: person.personId,
      label: person.name || t("medicines.errors.prn.unnamed"),
      cells: [
        String(person.prnGiven),
        String(person.psychotropicGiven),
        String(person.psychotropicPrnGiven),
      ],
    },
    ...person.byMedicine.map((m) => ({
      id: `${person.personId}-${m.medicineId}`,
      label: t("medicines.errors.prn.medicineRow", { medicine: m.name }),
      cells: [String(m.prnGiven), String(m.psychotropicGiven), ""],
    })),
  ]);
}
