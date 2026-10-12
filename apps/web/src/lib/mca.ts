import type {
  BestInterestsItem,
  ConsentDecisionStatus,
  ConsentItem,
  CreateCapacityAssessment,
  DolsItem,
  StaffName,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";

/**
 * View logic for the consent, capacity and DoLS tab (docs/specs/care.md rules 9 to 11; register
 * rows CARE-021 and CARE-022; hazards HZ-020 and HZ-026). Pure and unit tested. Every status, end
 * and day count is the API's (`consentStatus`, `dolsStatus`): the web only says them in words with
 * an icon, and a status it does not know is shown as a warning, never as calm.
 */

export type McaIcon =
  | "circle-check"
  | "circle-help"
  | "circle-alert"
  | "circle-minus"
  | "ban"
  | "clock"
  | "history"
  | "user-check"
  | "user-x";

export interface McaChip {
  readonly status:
    | "overdue"
    | "due"
    | "done"
    | "notApplicable"
    | "notRecorded"
    | "info"
    | "neutral";
  readonly icon: McaIcon;
  readonly label: string;
}

const when = (iso: string | null | undefined, t: Translator) =>
  formatDateTime(iso) ?? t("common.notRecorded");

/**
 * Whether a valid consent exists for one decision now, as `consentStatus` found it. Nothing
 * recorded asks for a record; a record that is not valid (withdrawn, expired, without authority)
 * is the stronger warning, because care may be going ahead on it (HZ-026).
 */
export function consentChip(
  decision: Pick<ConsentDecisionStatus, "status" | "problems">,
  t: Translator,
): McaChip {
  const label = (status: string) => t("care.mca.consent.status", { status });
  if (decision.status === "valid")
    return { status: "done", icon: "circle-check", label: label("valid") };
  if (decision.status === "refused")
    return { status: "info", icon: "ban", label: label("refused") };
  const nothing = decision.problems.length === 1 && decision.problems[0] === "no_record";
  return nothing
    ? { status: "notRecorded", icon: "circle-help", label: label("none") }
    : { status: "overdue", icon: "circle-alert", label: label("invalid") };
}

export type ConsentRecordState =
  | "in_force"
  | "refused"
  | "not_valid"
  | "withdrawn"
  | "expired"
  | "replaced";

/**
 * Where one consent record stands: the record that decides its decision now (the latest), or
 * replaced by a later one. A withdrawal or an expiry says so; the deciding record's validity is
 * the API's.
 */
export function consentRecordState(
  item: Pick<ConsentItem, "id" | "decision" | "withdrawnAt" | "expiresAt">,
  decisions: readonly Pick<ConsentDecisionStatus, "decision" | "status" | "recordId">[],
  now: Date = new Date(),
): ConsentRecordState {
  if (item.withdrawnAt) return "withdrawn";
  const deciding = decisions.find((d) => d.decision === item.decision);
  if (deciding?.recordId !== item.id) return "replaced";
  if (deciding.status === "valid") return "in_force";
  if (deciding.status === "refused") return "refused";
  return item.expiresAt && Date.parse(item.expiresAt) <= now.getTime() ? "expired" : "not_valid";
}

const RECORD_CHIPS: Record<ConsentRecordState, Omit<McaChip, "label">> = {
  in_force: { status: "done", icon: "circle-check" },
  refused: { status: "info", icon: "ban" },
  not_valid: { status: "overdue", icon: "circle-alert" },
  withdrawn: { status: "notApplicable", icon: "circle-minus" },
  expired: { status: "notApplicable", icon: "clock" },
  replaced: { status: "notApplicable", icon: "history" },
};

export function consentRecordChip(state: ConsentRecordState, t: Translator): McaChip {
  return { ...RECORD_CHIPS[state], label: t("care.mca.consent.record", { state }) };
}

/** Who gave or refused consent: the person, or the representative with their authority. */
export function consentGivenBy(
  item: Pick<ConsentItem, "givenBy" | "representative">,
  personName: string,
  t: Translator,
): string {
  if (item.givenBy === "person") return personName;
  return t("care.mca.consent.representative", {
    name: item.representative?.name ?? t("common.notRecorded"),
    kind: item.representative?.kind ?? "other",
  });
}

/** "Nell Nurse, Clinical lead", or the name alone. */
export function staffName(staff: StaffName, t: Translator): string {
  return staff.jobTitle
    ? t("care.mca.nameAndRole", { name: staff.displayName, role: staff.jobTitle })
    : staff.displayName;
}

// ------------------------------------------------------------------------------------------------
// Capacity and best interests (rules 9 and 10)
// ------------------------------------------------------------------------------------------------

/** The four abilities of the functional test (Mental Capacity Act 2005 s.3(1)), in its order. */
export const FUNCTIONAL_ELEMENTS = [
  "understand",
  "retain",
  "useOrWeigh",
  "communicate",
] as const satisfies readonly (keyof CreateCapacityAssessment["stage2"])[];

/** The section 4 checklist items, in the order the API's checklist takes them. */
export const BEST_INTERESTS_ITEMS = [
  "no_unjustified_assumptions",
  "relevant_circumstances",
  "regaining_capacity",
  "participation",
  "life_sustaining_treatment",
  "wishes_and_feelings",
  "beliefs_and_values",
  "other_factors",
  "views_of_others",
  "less_restrictive_option",
] as const satisfies readonly (keyof BestInterestsItem["checklist"])[];

/** The outcome of a capacity assessment as the two-stage test found it: a finding, not an alarm. */
export function capacityChip(outcome: "has_capacity" | "lacks_capacity", t: Translator): McaChip {
  return outcome === "has_capacity"
    ? { status: "neutral", icon: "user-check", label: t("care.mca.capacity.outcome", { outcome }) }
    : { status: "info", icon: "user-x", label: t("care.mca.capacity.outcome", { outcome }) };
}

/** A review date that has passed (compared as UK dates). */
export function reviewOverdue(reviewOn: string | null, today: string): boolean {
  return reviewOn !== null && reviewOn < today;
}

/** How many of the section 4 checklist items were answered. */
export function checklistAnswered(item: Pick<BestInterestsItem, "checklist">): number {
  return BEST_INTERESTS_ITEMS.filter((key) => item.checklist[key] !== undefined).length;
}

// ------------------------------------------------------------------------------------------------
// DoLS register (HZ-020)
// ------------------------------------------------------------------------------------------------

const DOLS_CHIPS: Record<DolsItem["status"], Omit<McaChip, "label">> = {
  requested: { status: "due", icon: "clock" },
  not_granted: { status: "notApplicable", icon: "circle-minus" },
  withdrawn: { status: "notApplicable", icon: "circle-minus" },
  not_started: { status: "info", icon: "clock" },
  active: { status: "done", icon: "circle-check" },
  expiring: { status: "due", icon: "clock" },
  expired: { status: "overdue", icon: "circle-alert" },
  ended: { status: "notApplicable", icon: "circle-minus" },
};

/** Where an authorisation stands, as `dolsStatus` found it; one the web does not know warns. */
export function dolsChip(status: string, t: Translator): McaChip {
  const known = DOLS_CHIPS[status as DolsItem["status"]];
  return known
    ? { ...known, label: t("care.mca.dols.status", { status }) }
    : { status: "overdue", icon: "circle-alert", label: t("care.mca.dols.status", { status }) };
}

const GRANTED = new Set(["not_started", "active", "expiring", "expired", "ended"]);

/**
 * The authorisation's clock in words and dates: when it starts or started, when it ends or ended
 * (the API's `endsAt`, the first moment it is no longer in force, so a shortened or extended end
 * shows as it is), and the whole UK days left while it is in force.
 */
export function dolsClock(
  item: Pick<DolsItem, "status" | "grantedFrom" | "endsAt" | "daysLeft">,
  t: Translator,
): string[] {
  if (!GRANTED.has(item.status)) return [];
  const lines: string[] = [];
  if (item.grantedFrom) {
    lines.push(
      t("care.mca.dols.from", { status: item.status, dateTime: when(item.grantedFrom, t) }),
    );
  }
  if (!item.endsAt) {
    lines.push(t("care.mca.dols.noEnd"));
    return lines;
  }
  lines.push(t("care.mca.dols.ends", { status: item.status, dateTime: when(item.endsAt, t) }));
  const running = item.status === "active" || item.status === "expiring";
  if (running && item.daysLeft !== null) {
    lines.push(t("care.mca.dols.daysLeft", { days: item.daysLeft }));
  }
  return lines;
}

/**
 * When the Registered Manager is reminded of the end, while the authorisation is still to end. The
 * date only: a reminder that would fall before an urgent authorisation starts is due at its start.
 */
export function dolsReminders(
  item: Pick<DolsItem, "status" | "reminders">,
  t: Translator,
): string[] {
  if (!["not_started", "active", "expiring"].includes(item.status)) return [];
  return item.reminders.map((reminder) =>
    t("care.mca.dols.reminder", { dateTime: when(reminder.dueAt, t) }),
  );
}

/** The CQC regulation 18(4A) notification for the outcome, or why none is needed (the API's words). */
export function dolsCqcLine(item: Pick<DolsItem, "cqcNotification">, t: Translator): string {
  const cqc = item.cqcNotification;
  const state = cqc.status ?? (cqc.required ? "missing" : null);
  if (state === null) return cqc.reason;
  return t("care.mca.dols.cqc", { state, due: when(cqc.dueAt, t) });
}
