import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import { type FormLike, readDateField, type TimeProblem } from "./uk-time";

/**
 * The outbreak screens (Phase 2 slice 63; SAFE-013; safety.md section 11): pure and unit tested.
 * The API (`/v1/safety/outbreaks`) runs every rule, fills the UKHSA report from the line list and
 * keeps the report's clock in the notification centre; these helpers name things in words and read
 * the forms.
 */

export const OUTBREAK_PERMISSION = "safety.outbreak.manage";
export const OUTBREAK_SYNDROMES = [
  "acute_respiratory",
  "flu",
  "covid_19",
  "diarrhoea_vomiting",
  "other",
] as const;
export const OUTBREAK_SYMPTOMS = [
  "fever",
  "cough",
  "sore_throat",
  "shortness_of_breath",
  "loss_of_taste_or_smell",
  "diarrhoea",
  "vomiting",
  "new_confusion",
  "other",
] as const;
export const OUTBREAK_TEST_TYPES = ["lateral_flow", "pcr", "stool_sample", "other"] as const;
export const OUTBREAK_TEST_RESULTS = ["not_tested", "pending", "positive", "negative"] as const;
export const VACCINATION_ANSWERS = ["yes", "no", "unknown"] as const;
export const OUTBREAK_OUTCOMES = ["unwell", "recovered", "hospitalised", "died"] as const;
export const CLOSE_REASON_MAX = 1_000;

export type OutbreakSyndrome = (typeof OUTBREAK_SYNDROMES)[number];

export function outbreaksShown(permissions: readonly string[]): boolean {
  return permissions.includes(OUTBREAK_PERMISSION);
}

/** Declared or closed as an icon and a word; an unknown state is a warning, never a fact. */
export function outbreakStateChip(state: string, t: Translator): SafetyChip {
  switch (state) {
    case "declared":
      return { status: "overdue", icon: "circle-alert", label: t("outbreaks.state", { state }) };
    case "closed":
      return { status: "neutral", icon: "circle-check", label: t("outbreaks.state", { state }) };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("outbreaks.state", { state: "unknown" }),
      };
  }
}

/** A line-list row: current, or superseded by a later row, in words. */
export function caseRowChip(current: boolean, t: Translator): SafetyChip {
  return current
    ? { status: "info", icon: "circle-check", label: t("outbreaks.case.current") }
    : { status: "notApplicable", icon: "circle-minus", label: t("outbreaks.case.superseded") };
}

type Read<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };
type FormWithAll = FormLike & { getAll?: (name: string) => unknown[] };

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const oneOf = <T extends string>(list: readonly T[], value: string): T | null =>
  (list as readonly string[]).includes(value) ? (value as T) : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failed<T>(
  errors: Record<string, string>,
  parts: Record<string, readonly string[]> = {},
): Read<T> {
  return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
}

/** An optional text of 2 to 200 characters (organism) or 1 to 100 (reference); "" means none. */
function optionalText(
  form: FormLike,
  name: string,
  min: number,
  max: number,
  errors: Record<string, string>,
  message: string,
): string | null {
  const value = text(form, name);
  if (!value) return null;
  if (value.length < min || value.length > max) errors[name] = message;
  return value;
}

export function readDeclareOutbreak(
  form: FormLike,
  t: Translator,
): Read<{
  locationId: string;
  syndrome: OutbreakSyndrome;
  organism?: string;
  hptReference?: string;
}> {
  const errors: Record<string, string> = {};
  const locationId = text(form, "locationId");
  if (!UUID.test(locationId)) errors.locationId = t("outbreaks.form.locationError");
  const syndrome = oneOf(OUTBREAK_SYNDROMES, text(form, "syndrome"));
  if (!syndrome) errors.syndrome = t("outbreaks.form.syndromeError");
  const organism = optionalText(
    form,
    "organism",
    2,
    200,
    errors,
    t("outbreaks.form.organismError"),
  );
  const hptReference = optionalText(
    form,
    "hptReference",
    1,
    100,
    errors,
    t("outbreaks.form.referenceError"),
  );
  if (Object.keys(errors).length > 0 || !syndrome) return failed(errors);
  return {
    ok: true,
    body: {
      locationId,
      syndrome,
      ...(organism ? { organism } : {}),
      ...(hptReference ? { hptReference } : {}),
    },
  };
}

export function readUpdateOutbreak(
  form: FormLike,
  t: Translator,
  options: { readonly version: number },
): Read<{ version: number; organism: string | null; hptReference: string | null }> {
  const errors: Record<string, string> = {};
  const organism = optionalText(
    form,
    "organism",
    2,
    200,
    errors,
    t("outbreaks.form.organismError"),
  );
  const hptReference = optionalText(
    form,
    "hptReference",
    1,
    100,
    errors,
    t("outbreaks.form.referenceError"),
  );
  if (Object.keys(errors).length > 0) return failed(errors);
  return { ok: true, body: { version: options.version, organism, hptReference } };
}

export function readCloseOutbreak(
  form: FormLike,
  t: Translator,
  options: { readonly version: number },
): Read<{ version: number; closedOn: string; reason: string }> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const closed = readDateField(form, "closedOn", { subject: t("outbreaks.close.dateSubject"), t });
  if (!closed.ok) {
    errors.closedOn = (closed as TimeProblem).message;
    parts.closedOn = (closed as TimeProblem).parts;
  }
  const reason = text(form, "reason");
  if (reason.length < 3 || reason.length > CLOSE_REASON_MAX) {
    errors.reason = t("outbreaks.close.reasonError", { max: CLOSE_REASON_MAX });
  }
  if (Object.keys(errors).length > 0 || !closed.ok || !closed.date) return failed(errors, parts);
  return { ok: true, body: { version: options.version, closedOn: closed.date, reason } };
}

export interface RecordCaseBody {
  readonly caseType: "resident";
  readonly personId: string;
  readonly tenantUserId: null;
  readonly onsetOn: string;
  readonly symptoms: (typeof OUTBREAK_SYMPTOMS)[number][];
  readonly testType: (typeof OUTBREAK_TEST_TYPES)[number] | null;
  readonly testedOn: string | null;
  readonly testResult: (typeof OUTBREAK_TEST_RESULTS)[number];
  readonly fluVaccinated: (typeof VACCINATION_ANSWERS)[number];
  readonly covidVaccinated: (typeof VACCINATION_ANSWERS)[number];
  readonly outcome: (typeof OUTBREAK_OUTCOMES)[number];
  readonly outcomeOn: string | null;
  readonly supersedesId: null;
  readonly correctionReason: null;
}

/**
 * A resident's line-list row. Staff rows need the member of staff, which these screens cannot
 * choose yet; the page says so. The API refuses anything its rules do not allow (for example a
 * test result without the test).
 */
export function readRecordCase(form: FormWithAll, t: Translator): Read<RecordCaseBody> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const date = (name: string, subject: string, optional: boolean) => {
    const read = readDateField(form, name, { subject, t, optional });
    if (read.ok) return read.date;
    errors[name] = (read as TimeProblem).message;
    parts[name] = (read as TimeProblem).parts;
    return null;
  };
  const personId = text(form, "personId");
  if (!UUID.test(personId)) errors.personId = t("outbreaks.case.personError");
  const onsetOn = date("onsetOn", t("outbreaks.case.onsetSubject"), false);
  const symptoms = [
    ...new Set(
      (form.getAll?.("symptoms") ?? []).filter(
        (v): v is (typeof OUTBREAK_SYMPTOMS)[number] =>
          typeof v === "string" && (OUTBREAK_SYMPTOMS as readonly string[]).includes(v),
      ),
    ),
  ];
  if (symptoms.length === 0) errors.symptoms = t("outbreaks.case.symptomsError");
  const testResult = oneOf(OUTBREAK_TEST_RESULTS, text(form, "testResult")) ?? "not_tested";
  const testType = oneOf(OUTBREAK_TEST_TYPES, text(form, "testType"));
  const testedOn = date("testedOn", t("outbreaks.case.testedSubject"), true);
  if (testResult !== "not_tested" && !testType) {
    errors.testType = t("outbreaks.case.testTypeError");
  }
  const outcome = oneOf(OUTBREAK_OUTCOMES, text(form, "outcome")) ?? "unwell";
  const outcomeOn = date("outcomeOn", t("outbreaks.case.outcomeSubject"), true);
  if (outcome !== "unwell" && !outcomeOn && !errors.outcomeOn) {
    errors.outcomeOn = t("outbreaks.case.outcomeOnError");
  }
  if (Object.keys(errors).length > 0 || !onsetOn) return failed(errors, parts);
  return {
    ok: true,
    body: {
      caseType: "resident",
      personId,
      tenantUserId: null,
      onsetOn,
      symptoms,
      testType: testResult === "not_tested" ? null : testType,
      testedOn: testResult === "not_tested" ? null : testedOn,
      testResult,
      fluVaccinated: oneOf(VACCINATION_ANSWERS, text(form, "fluVaccinated")) ?? "unknown",
      covidVaccinated: oneOf(VACCINATION_ANSWERS, text(form, "covidVaccinated")) ?? "unknown",
      outcome,
      outcomeOn: outcome === "unwell" ? null : outcomeOn,
      supersedesId: null,
      correctionReason: null,
    },
  };
}
