import type {
  CapacityAssessmentItem,
  ConsentDecisionStatus,
  ConsentItem,
  DolsItem,
} from "@harbour/contracts";
import {
  type ConsentProblem,
  capacityFinding,
  DOLS_LEGAL_CHANGE,
  ukStartOfDay,
} from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import { formatDate, formatDateTime } from "./format";
import { addDays, formatUkTime, ukToday } from "./uk-time";

/**
 * View logic for the consent, capacity and DoLS tab (docs/specs/care.md rules 9 to 11; register
 * rows CARE-021 and CARE-022; hazards HZ-020 and HZ-026). Pure and unit tested. Every status, end
 * and finding is the API's (`consentStatus`, `dolsStatus`) or the domain's own rule: the web says
 * them in the catalogue's words with an icon, never the API's English or internal names, and a
 * value it does not know is a warning, never a calm fact.
 */

export type McaIcon =
  | "circle-check"
  | "circle-help"
  | "circle-alert"
  | "circle-minus"
  | "ban"
  | "clock"
  | "refresh-cw"
  | "triangle-alert";

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

/** Words about a moment, with the instant for a `<time>` element when there is one. */
export interface McaLine {
  readonly text: string;
  readonly dateTime: string | null;
}

const line = (text: string, dateTime: string | null = null): McaLine => ({ text, dateTime });

/** The UK calendar date of an instant, as dd/mm/yyyy. */
const ukDate = (iso: string) => formatDate(ukToday(new Date(iso))) ?? "";

// ------------------------------------------------------------------------------------------------
// Consent by decision (rule 9; HZ-026)
// ------------------------------------------------------------------------------------------------

/**
 * Every reason `consentStatus` gives, so each is said in the catalogue's words (en-GB and Welsh).
 * A `Record` so a reason added to the domain fails the type check until it is worded here.
 */
export const CONSENT_PROBLEMS: Readonly<Record<ConsentProblem, true>> = {
  no_record: true,
  not_yet_given: true,
  withdrawn: true,
  expired: true,
  evidence_missing: true,
  person_lacks_capacity: true,
  covert_needs_lack_of_capacity: true,
  best_interests_decision_missing: true,
  representative_not_permitted: true,
  representative_has_no_authority: true,
  representative_needs_lack_of_capacity: true,
  person_has_capacity_now: true,
  lpa_not_registered: true,
  lpa_excludes_decision: true,
  lpa_wrong_kind: true,
  deputy_order_does_not_cover: true,
  deputy_order_ended: true,
  restraint_conditions_missing: true,
  restraint_not_authorised: true,
};

export interface DecisionView {
  readonly chip: McaChip;
  /** Who refused, or why no consent is valid and what to do: null when consent is in place. */
  readonly reason: string | null;
  /** The capacity found for the decision, with the date of the assessment that found it. */
  readonly capacity: string;
  /** "Review by dd/mm/yyyy" or "No review date set", when an assessment found it. */
  readonly review: string | null;
  readonly reviewOverdue: boolean;
}

/**
 * One decision's row: whether a valid consent is in place now, as the API found it. Nothing
 * recorded is a warning that asks for a record; a record that is not valid (withdrawn, expired,
 * without authority) is the stronger warning, because care may be going ahead on it; a refusal is
 * a warning too. The capacity assessment the API used is found with the domain's own rule
 * (`capacityFinding`, the latest assessment of this decision) to show its date and review date;
 * when it does not agree with the API's finding, only the API's finding is shown.
 */
export function decisionView(
  decision: ConsentDecisionStatus,
  records: readonly Pick<ConsentItem, "id" | "givenBy">[],
  assessments: readonly Pick<
    CapacityAssessmentItem,
    "id" | "decisionKind" | "assessedAt" | "outcome" | "reviewOn" | "superseded"
  >[],
  personName: string,
  t: Translator,
  now: Date = new Date(),
): DecisionView {
  const status = (key: string) => t("care.mca.consent.status", { status: key });
  let chip: McaChip;
  let reason: string | null = null;
  if (decision.status === "valid") {
    chip = { status: "done", icon: "circle-check", label: status("valid") };
  } else if (decision.status === "refused") {
    chip = { status: "due", icon: "ban", label: status("refused") };
    const by = records.find((r) => r.id === decision.recordId)?.givenBy ?? "unknown";
    reason = t("care.mca.consent.refusedBy", { by, name: personName });
  } else {
    const nothing = decision.problems.length === 1 && decision.problems[0] === "no_record";
    chip = nothing
      ? { status: "notRecorded", icon: "circle-help", label: status("none") }
      : { status: "overdue", icon: "circle-alert", label: status("invalid") };
    const problems = decision.problems.length > 0 ? decision.problems : ["unknown"];
    reason = problems
      .map((problem) =>
        t("care.mca.consent.problem", {
          problem: Object.hasOwn(CONSENT_PROBLEMS, problem) ? problem : "other",
        }),
      )
      .join(" ");
  }

  const views = assessments
    .filter((a) => !a.superseded)
    .map((a) => ({ ...a, assessedAt: new Date(a.assessedAt) }));
  const found = capacityFinding(views, decision.decision, now, ukToday(now));
  const agrees = found.status !== "assumed" && found.status === decision.capacity;
  return {
    chip,
    reason,
    capacity: agrees
      ? t("care.mca.consent.assessedOn", {
          capacity: decision.capacity,
          date: ukDate(found.assessment.assessedAt.toISOString()),
        })
      : t("care.mca.consent.capacityNow", { capacity: decision.capacity }),
    review: agrees
      ? found.assessment.reviewOn
        ? t("care.mca.reviewBy", { date: formatDate(found.assessment.reviewOn) ?? "" })
        : t("care.mca.noReviewDate")
      : null,
    reviewOverdue: decision.capacityReviewOverdue,
  };
}

// ------------------------------------------------------------------------------------------------
// DoLS register (rule 11; HZ-020)
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

/**
 * The authorisations a later granted one names as the one it follows
 * (`precededByAuthorisationId`) and takes over from without a gap: the follower starts no later
 * than the one it follows ends. Such an expired one was renewed, not left to lapse. When the
 * follower starts later, or either time is unknown, the earlier one stays "Expired", so a gap with
 * no authorisation in force never reads as calm (HZ-020; #34 review round 2).
 */
export function renewedIds(
  items: readonly Pick<
    DolsItem,
    "id" | "outcome" | "precededByAuthorisationId" | "grantedFrom" | "endsAt"
  >[],
): ReadonlySet<string> {
  const byId = new Map(items.map((item) => [item.id, item]));
  return new Set(
    items.flatMap((item) => {
      if (item.outcome !== "granted" || !item.precededByAuthorisationId) return [];
      const before = byId.get(item.precededByAuthorisationId);
      if (!before?.endsAt || !item.grantedFrom) return [];
      return Date.parse(item.grantedFrom) <= Date.parse(before.endsAt) ? [before.id] : [];
    }),
  );
}

/**
 * Where an authorisation stands, as `dolsStatus` found it. An expired one that a later granted
 * authorisation follows reads "Renewed", in a neutral tone; one the web does not know warns.
 */
export function dolsChip(status: string, renewed: boolean, t: Translator): McaChip {
  if (status === "expired" && renewed) {
    return { status: "neutral", icon: "refresh-cw", label: t("care.mca.dols.renewed") };
  }
  const known = DOLS_CHIPS[status as DolsItem["status"]];
  return known
    ? { ...known, label: t("care.mca.dols.status", { status }) }
    : { status: "overdue", icon: "circle-alert", label: t("care.mca.dols.status", { status }) };
}

/** "Urgent authorisation of 12/10/2026": the heading, and with `history`, the history link. */
export function dolsTitle(
  item: Pick<DolsItem, "type" | "requestedAt">,
  t: Translator,
  history = false,
): string {
  const values = { type: item.type, date: ukDate(item.requestedAt) };
  return history ? t("care.mca.dols.historyLink", values) : t("care.mca.dols.title", values);
}

/**
 * The last UK day an authorisation is in force. The API's end is the first moment it is no longer
 * in force, so an end at 00:00 UK time means the day before was the last day.
 */
export function lastDayInForce(endsAt: string): string {
  const day = ukToday(new Date(endsAt));
  return formatUkTime(endsAt) === "00:00" ? addDays(day, -1) : day;
}

const GRANTED = new Set(["not_started", "active", "expiring", "expired", "ended"]);

/** Whole calendar days from one UK date (yyyy-mm-dd) to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The authorisation's clock in words and UK dates: when it starts or started; when it ends or
 * ended, as the last day in force when it ends at midnight ("In force until the end of
 * 20/10/2026"), else the date and time; and, while in force, how long until its last day, which
 * reads "Today is the last day in force" only on that day.
 */
export function dolsClock(
  item: Pick<DolsItem, "status" | "grantedFrom" | "endsAt">,
  t: Translator,
  now: Date = new Date(),
): McaLine[] {
  if (!GRANTED.has(item.status)) return [];
  const lines: McaLine[] = [];
  if (item.grantedFrom) {
    lines.push(
      line(
        t("care.mca.dols.from", {
          status: item.status,
          dateTime: formatDateTime(item.grantedFrom) ?? "",
        }),
        item.grantedFrom,
      ),
    );
  }
  if (!item.endsAt) {
    lines.push(line(t("care.mca.dols.noEnd")));
    return lines;
  }
  const lastDay = lastDayInForce(item.endsAt);
  const midnight = formatUkTime(item.endsAt) === "00:00";
  lines.push(
    line(
      midnight
        ? t("care.mca.dols.untilEndOf", { status: item.status, date: formatDate(lastDay) ?? "" })
        : t("care.mca.dols.ends", {
            status: item.status,
            dateTime: formatDateTime(item.endsAt) ?? "",
          }),
      item.endsAt,
    ),
  );
  if (item.status === "active" || item.status === "expiring") {
    const days = daysBetween(ukToday(now), lastDay);
    if (days >= 0) lines.push(line(t("care.mca.dols.daysLeft", { days })));
  }
  return lines;
}

/** When it was asked for, and its outcome, never "Granted" beside a missing date. */
export function dolsHistoryLines(
  item: Pick<DolsItem, "type" | "requestedAt" | "outcome" | "outcomeAt" | "extensions">,
  t: Translator,
): McaLine[] {
  const lines = [
    line(
      t("care.mca.dols.requested", {
        type: item.type,
        dateTime: formatDateTime(item.requestedAt) ?? "",
      }),
      item.requestedAt,
    ),
  ];
  if (item.outcome !== "pending") {
    const at = formatDateTime(item.outcomeAt);
    lines.push(
      at
        ? line(t("care.mca.dols.outcome", { outcome: item.outcome, dateTime: at }), item.outcomeAt)
        : line(t("care.mca.dols.outcomeUndated", { outcome: item.outcome })),
    );
  }
  for (const extension of item.extensions) {
    lines.push(
      line(
        t("care.mca.dols.extension", {
          outcome:
            extension.outcome === "granted" && !extension.extendedTo
              ? "granted_undated"
              : extension.outcome,
          dateTime: formatDateTime(extension.requestedAt) ?? "",
          to: formatDateTime(extension.extendedTo) ?? "",
        }),
        extension.requestedAt,
      ),
    );
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
): McaLine[] {
  if (!["not_started", "active", "expiring"].includes(item.status)) return [];
  return item.reminders.map((reminder) =>
    line(
      t("care.mca.dols.reminder", { dateTime: formatDateTime(reminder.dueAt) ?? "" }),
      reminder.dueAt,
    ),
  );
}

/**
 * The CQC regulation 18(4A) notification for the outcome, or why none is needed, in the
 * catalogue's words (never the API's English reason).
 */
export function dolsCqcLines(
  item: Pick<DolsItem, "cqcNotification" | "nation" | "type" | "outcome">,
  t: Translator,
): McaLine[] {
  const cqc = item.cqcNotification;
  const state =
    cqc.status ??
    (cqc.required
      ? "missing"
      : item.nation !== "england"
        ? "other_nation"
        : item.type === "urgent"
          ? "urgent"
          : item.outcome === "pending"
            ? "pending"
            : "unknown");
  const lines = [line(t("care.mca.dols.cqc", { state }))];
  if (state === "draft" || state === "ready") {
    const due = formatDateTime(cqc.dueAt);
    lines.push(
      due
        ? line(t("care.mca.dols.cqcDue", { dateTime: due }), cqc.dueAt)
        : line(t("care.mca.dols.cqcNoDue")),
    );
  }
  return lines;
}

export interface LegalReviewView {
  /** A warning when the review the June 2026 judgment calls for has not been done. */
  readonly chip: McaChip | null;
  readonly text: string;
}

/**
 * The review of an authorisation after the June 2026 Supreme Court judgment (care.md rule 11). One
 * the domain lists as awaiting review (granted before the judgment, still in force, no review or
 * one awaiting review) warns with the next step, whether or not a review has been started; a
 * review in another state says where it stands, and a state the web does not know warns.
 */
export function legalReviewView(
  item: Pick<DolsItem, "status" | "outcome" | "grantedFrom" | "legalChangeReview">,
  t: Translator,
): LegalReviewView | null {
  const state = item.legalChangeReview;
  const judgment = ukStartOfDay(DOLS_LEGAL_CHANGE.judgment.decidedOn).getTime();
  const awaiting =
    (state === null || state === "awaiting_review") &&
    item.outcome === "granted" &&
    item.grantedFrom !== null &&
    Date.parse(item.grantedFrom) < judgment &&
    (item.status === "active" || item.status === "expiring");
  if (awaiting) {
    return {
      chip: {
        status: "due",
        icon: "triangle-alert",
        label: t("care.mca.dols.legalReview", { state: "not_started" }),
      },
      text: t("care.mca.dols.legalReviewNext"),
    };
  }
  if (state === null) return null;
  const known = ["awaiting_review", "reviewed", "referred", "closed"].includes(state);
  return {
    chip: known
      ? null
      : {
          status: "overdue",
          icon: "circle-alert",
          label: t("care.mca.dols.legalReview", { state }),
        },
    text: t("care.mca.dols.legalReview", { state }),
  };
}
