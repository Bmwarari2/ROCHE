/**
 * Deprivation of Liberty Safeguards register (care.md section 4 rule 11; CARE-022; hazard HZ-020).
 * England and Wales only: Schedule A1 to the Mental Capacity Act 2005 (legislation.gov.uk, read
 * 11 October 2026). Scotland and Northern Ireland arrive with their nation packs (Phase 7).
 *
 * - Urgent authorisation: para 78(2) "That period must not exceed 7 days"; para 77(4) "Only one
 *   request under sub-paragraph (3) may be made" to extend it; para 85(3) the extension "must not
 *   exceed 7 days".
 * - Standard authorisation: para 42(2)(b) and para 51(2), at most "1 year, or such shorter period as
 *   may be prescribed in regulations".
 * - CQC (Registration) Regulations 2009 reg 18(4A) and (4B): notify CQC of a request for a standard
 *   authorisation, and of an application to the court, "once the outcome of the request or
 *   application is known or, if the request or application is withdrawn, at the point of
 *   withdrawal". England only.
 *
 * Every figure comes from the rate table (`dols.*`), resolved by the caller; nothing here is a
 * literal. Expiry reminders (28 and 7 days by default) are tenant settings.
 */

import type { FlagKey, FlagRow } from "../../platform/feature-flags";
import { evaluateFlag } from "../../platform/feature-flags";
import { type RateRow, resolveRate } from "../../platform/rates";
import { defineWorkflow } from "../../platform/workflow";
import { type Citation, cite, SOURCES } from "../../shared/citation";
import { addUkDays, addUkMonths, ukStartOfDay } from "../../shared/time";
import type { InputIssue } from "../assessment";

export const DOLS_RATE_KEYS = {
  urgentDays: "dols.urgent.days",
  urgentExtensionDays: "dols.urgent.extension_days",
  urgentMaxExtensionRequests: "dols.urgent.max_extension_requests",
  standardMaxMonths: "dols.standard.max_months",
  firstReminderDays: "dols.expiry_reminder_days.first",
  secondReminderDays: "dols.expiry_reminder_days.second",
} as const;

export type DolsRateName = keyof typeof DOLS_RATE_KEYS;
export type DolsRates = { readonly [K in DolsRateName]: number };

/** DoLS is law in England and Wales only. */
export const DOLS_NATIONS = ["england", "wales"] as const;
export type DolsNation = (typeof DOLS_NATIONS)[number];

export function resolveDolsRates(
  rows: readonly RateRow[],
  nation: DolsNation,
  on: string,
  tenantId: string | null,
): DolsRates {
  const entries = (Object.keys(DOLS_RATE_KEYS) as DolsRateName[]).map(
    (name) => [name, resolveRate(rows, DOLS_RATE_KEYS[name], nation, on, tenantId).value] as const,
  );
  return Object.fromEntries(entries) as DolsRates;
}

const A1 = (paragraph: string) =>
  cite("Mental Capacity Act 2005", `Schedule A1 ${paragraph}`, SOURCES.mcaScheduleA1);

export const DOLS_SOURCES = {
  urgentPeriod: A1("para 78(2)"),
  oneExtension: A1("para 77(4)"),
  extensionPeriod: A1("para 85(3)"),
  standardPeriod: A1("para 42(2)(b) and para 51(2)"),
  reviewRequest: A1("para 102 and para 103"),
  reviewTermination: A1("para 117"),
  cqcNotification: cite(
    "CQC (Registration) Regulations 2009",
    "reg 18(4A) and (4B)",
    SOURCES.cqcReg18,
  ),
  cqcForm: cite(
    "CQC",
    "Outcome of an application to deprive a person of their liberty (DoLS)",
    SOURCES.cqcDolsForm,
  ),
} as const satisfies Record<string, Citation>;

export type DolsAuthorisationType = "urgent" | "standard" | "court_order";
export type DolsOutcome = "pending" | "granted" | "not_granted" | "withdrawn";

export interface UrgentExtension {
  readonly requestedAt: Date;
  readonly outcome: "pending" | "granted" | "refused";
  /** The new end (exclusive) once granted. */
  readonly extendedTo: Date | null;
}

export interface DolsAuthorisationView {
  readonly id: string;
  readonly type: DolsAuthorisationType;
  readonly nation: DolsNation;
  /**
   * Standard: when the request went to the supervisory body. Court order: when the application was
   * made. Urgent: when the managing authority gave it.
   */
  readonly requestedAt: Date;
  readonly outcome: DolsOutcome;
  readonly outcomeAt: Date | null;
  readonly grantedFrom: Date | null;
  /** The first moment it is no longer in force. A court order may have no end date. */
  readonly grantedTo: Date | null;
  readonly extensions?: readonly UrgentExtension[];
  /** A standard request that followed an urgent authorisation (reg 18(4B)(b)). */
  readonly precededByUrgent?: boolean;
  readonly withdrawalReason?: string | null;
  /** Ended early: terminated after a review (para 117), or the person left the home or died. */
  readonly endedAt?: Date | null;
}

const issue = (item: string, problem: InputIssue["problem"], message: string): InputIssue => ({
  item,
  problem,
  message,
});

/** Checks the dates of an authorisation against the Schedule A1 limits before it is saved. */
export function checkDolsAuthorisation(
  auth: DolsAuthorisationView,
  rates: DolsRates,
): InputIssue[] {
  const issues: InputIssue[] = [];
  if (auth.outcome !== "pending" && !auth.outcomeAt) {
    issues.push(issue("outcomeAt", "missing", "Record when the outcome was known."));
  }
  if (auth.outcome === "withdrawn" && !(auth.withdrawalReason?.trim() ?? "")) {
    issues.push(issue("withdrawalReason", "missing", "Record why the request was withdrawn."));
  }
  const extensions = auth.extensions ?? [];
  if (extensions.length > 0 && auth.type !== "urgent") {
    issues.push(
      issue("extensions", "not_allowed", "Only an urgent authorisation can be extended."),
    );
  }
  if (extensions.length > rates.urgentMaxExtensionRequests) {
    issues.push(
      issue(
        "extensions",
        "not_allowed",
        `Only ${rates.urgentMaxExtensionRequests} request to extend an urgent authorisation may be made (Schedule A1 para 77(4)).`,
      ),
    );
  }
  if (auth.outcome !== "granted") return issues;

  const from = auth.grantedFrom;
  const to = auth.grantedTo;
  if (!from) issues.push(issue("grantedFrom", "missing", "Record when the authorisation starts."));
  if (!to && auth.type !== "court_order") {
    issues.push(issue("grantedTo", "missing", "Record when the authorisation ends."));
  }
  if (!from || !to) return issues;
  if (to.getTime() <= from.getTime()) {
    issues.push(issue("grantedTo", "out_of_range", "The end must be after the start."));
    return issues;
  }
  if (auth.type === "urgent" && to.getTime() > addUkDays(from, rates.urgentDays).getTime()) {
    issues.push(
      issue(
        "grantedTo",
        "out_of_range",
        `An urgent authorisation must not exceed ${rates.urgentDays} days (Schedule A1 para 78(2)).`,
      ),
    );
  }
  if (
    auth.type === "standard" &&
    to.getTime() > addUkMonths(from, rates.standardMaxMonths).getTime()
  ) {
    issues.push(
      issue(
        "grantedTo",
        "out_of_range",
        `A standard authorisation must not exceed ${rates.standardMaxMonths} months (Schedule A1 para 42(2)(b)).`,
      ),
    );
  }
  extensions.forEach((ext, i) => {
    if (ext.outcome !== "granted") return;
    const until = ext.extendedTo;
    if (!until || until.getTime() <= to.getTime()) {
      issues.push(
        issue(
          `extensions.${i}`,
          "out_of_range",
          "The extended end must be after the original end.",
        ),
      );
    } else if (until.getTime() > addUkDays(to, rates.urgentExtensionDays).getTime()) {
      issues.push(
        issue(
          `extensions.${i}`,
          "out_of_range",
          `An extension must not exceed ${rates.urgentExtensionDays} days (Schedule A1 para 85(3)).`,
        ),
      );
    }
  });
  return issues;
}

/** When the authorisation stops being in force, or null when it was never granted or has no end. */
export function dolsEndsAt(auth: DolsAuthorisationView): Date | null {
  if (auth.outcome !== "granted" || !auth.grantedFrom) return null;
  const extended = (auth.extensions ?? [])
    .filter((e) => e.outcome === "granted" && e.extendedTo)
    .map((e) => e.extendedTo as Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const end = extended ?? auth.grantedTo;
  if (auth.endedAt && (!end || auth.endedAt.getTime() < end.getTime())) return auth.endedAt;
  return end;
}

export type DolsStatus =
  | "requested"
  | "not_granted"
  | "withdrawn"
  | "not_started"
  | "active"
  | "expiring"
  | "expired"
  | "ended";

export interface DolsStatusView {
  readonly status: DolsStatus;
  readonly endsAt: Date | null;
  /** Whole UK calendar days left until the end (0 on the last day), when there is an end. */
  readonly daysLeft: number | null;
}

/** Whole UK calendar days from `from` until `to` (a day across a clock change still counts as one). */
function daysBetween(from: Date, to: Date): number {
  let days = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000) - 1);
  while (addUkDays(from, days + 1).getTime() <= to.getTime()) days++;
  return days;
}

/** Where an authorisation stands at a time (the register list and HZ-020 alerts read this). */
export function dolsStatus(
  auth: DolsAuthorisationView,
  rates: DolsRates,
  at: Date,
): DolsStatusView {
  const view = (status: DolsStatus, endsAt: Date | null = null): DolsStatusView => ({
    status,
    endsAt,
    daysLeft: endsAt && endsAt.getTime() > at.getTime() ? daysBetween(at, endsAt) : null,
  });
  if (auth.outcome === "pending") return view("requested");
  if (auth.outcome === "not_granted") return view("not_granted");
  if (auth.outcome === "withdrawn") return view("withdrawn");
  const endsAt = dolsEndsAt(auth);
  if (auth.endedAt && auth.endedAt.getTime() <= at.getTime()) return view("ended", endsAt);
  if (auth.grantedFrom && at.getTime() < auth.grantedFrom.getTime())
    return view("not_started", endsAt);
  if (!endsAt) return view("active");
  if (at.getTime() >= endsAt.getTime()) return view("expired", endsAt);
  if (at.getTime() >= addUkDays(endsAt, -rates.firstReminderDays).getTime()) {
    return view("expiring", endsAt);
  }
  return view("active", endsAt);
}

export interface DolsReminder {
  readonly key: "first" | "second";
  readonly daysBefore: number;
  readonly dueAt: Date;
  readonly endsAt: Date;
}

/**
 * Expiry reminders for the Registered Manager: `dols.expiry_reminder_days.first` and `.second`
 * days before the end (tenant settings). A reminder that would fall before the authorisation
 * starts (an urgent authorisation is shorter than the first reminder) fires when it starts; two
 * reminders at the same moment become one.
 */
export function dolsReminders(auth: DolsAuthorisationView, rates: DolsRates): DolsReminder[] {
  const endsAt = dolsEndsAt(auth);
  // An authorisation ended early (after a review, or the person left or died) needs no reminder.
  if (!endsAt || !auth.grantedFrom || auth.endedAt) return [];
  const start = auth.grantedFrom;
  const reminders: DolsReminder[] = [];
  for (const [key, daysBefore] of [
    ["first", rates.firstReminderDays],
    ["second", rates.secondReminderDays],
  ] as const) {
    const ideal = addUkDays(endsAt, -daysBefore);
    const dueAt = ideal.getTime() < start.getTime() ? start : ideal;
    if (!reminders.some((r) => r.dueAt.getTime() === dueAt.getTime())) {
      reminders.push({ key, daysBefore, dueAt, endsAt });
    }
  }
  return reminders;
}

/** The statement reg 18(4B) requires in the CQC notification. */
export interface DolsOutcomeStatement {
  /** (a) the date and nature of the request or application. */
  readonly requestDate: Date;
  readonly nature: string;
  /** (b) whether it was preceded by an urgent authorisation. */
  readonly precededByUrgent: boolean;
  /** (c) the outcome or the reason for withdrawal. */
  readonly outcome: string;
  /** (d) the date of the outcome or withdrawal. */
  readonly outcomeDate: Date;
}

export type DolsNotificationDecision =
  | {
      readonly required: true;
      readonly kind: "cqc_reg18_dols_outcome";
      /** Reg 18(4B): given once the outcome is known, so due from that moment. */
      readonly dueAt: Date;
      readonly statement: DolsOutcomeStatement;
      readonly reason: string;
      readonly sources: readonly Citation[];
    }
  | { readonly required: false; readonly reason: string; readonly sources: readonly Citation[] };

/**
 * Whether the outcome of a DoLS request or court application needs the CQC notification (hazard
 * HZ-020 with HZ-013). CQC's form page: "Do not tell us you are making an application. Only tell
 * us about outcomes or withdrawn applications", including court applications the provider did not
 * make.
 */
export function dolsCqcNotification(auth: DolsAuthorisationView): DolsNotificationDecision {
  const sources = [DOLS_SOURCES.cqcNotification, DOLS_SOURCES.cqcForm];
  if (auth.nation !== "england") {
    return {
      required: false,
      reason:
        "CQC notifications apply to services in England. Care Inspectorate Wales notification rules arrive with the Wales nation pack (Phase 7).",
      sources,
    };
  }
  if (auth.type === "urgent") {
    return {
      required: false,
      reason:
        "An urgent authorisation is not notified on its own: the notification for the standard request it accompanies says that an urgent authorisation preceded it (reg 18(4B)(b)).",
      sources,
    };
  }
  if (auth.outcome === "pending" || !auth.outcomeAt) {
    return {
      required: false,
      reason:
        "Not yet: CQC is told once the outcome is known or the request is withdrawn (reg 18(4B)).",
      sources,
    };
  }
  const nature =
    auth.type === "standard"
      ? "Request to the supervisory body for a standard authorisation (Mental Capacity Act 2005 Schedule A1 Part 4)"
      : "Application to the court in relation to depriving the person of their liberty (Mental Capacity Act 2005 s.16(2)(a))";
  const outcome =
    auth.outcome === "granted"
      ? "Granted"
      : auth.outcome === "not_granted"
        ? "Not granted"
        : `Withdrawn: ${auth.withdrawalReason ?? ""}`.trim();
  return {
    required: true,
    kind: "cqc_reg18_dols_outcome",
    dueAt: auth.outcomeAt,
    statement: {
      requestDate: auth.requestedAt,
      nature,
      precededByUrgent: auth.precededByUrgent === true,
      outcome,
      outcomeDate: auth.outcomeAt,
    },
    reason: `The outcome of the ${auth.type === "standard" ? "request for a standard authorisation" : "court application"} is known (reg 18(4A) and (4B)).`,
    sources,
  };
}

/**
 * The June 2026 legal change (care.md rule 11; master prompt 10.4). The Supreme Court decided
 * A Reference by the Attorney General for Northern Ireland [2026] UKSC 16 on 2 June 2026. DHSC
 * interim guidance (published 15 June 2026, updated 22 September 2026) says existing
 * authorisations whose person may no longer be deprived of liberty "should be reviewed as soon as
 * is practicable", and that DoLS still applies in hospitals and care homes. The tenant switch is
 * the feature flag below; legal content is quoted from the guidance and never paraphrased into a
 * test of Harbour's own. Further DHSC guidance is expected (human action H-62).
 */
export const DOLS_LEGAL_CHANGE = {
  flag: "dols.post_2026_review_workflow" satisfies FlagKey,
  nations: DOLS_NATIONS,
  judgment: {
    name: "A Reference by the Attorney General for Northern Ireland of a devolution issue under paragraph 34 of Schedule 10 to the Northern Ireland Act 1998",
    citation: "[2026] UKSC 16",
    decidedOn: "2026-06-02",
    url: SOURCES.supremeCourtDol2026,
  },
  guidance: {
    title: "UK Supreme Court 2026 judgment on what constitutes a deprivation of liberty",
    publisher: "Department of Health and Social Care",
    publishedOn: "2026-06-15",
    lastUpdatedOn: "2026-09-22",
    url: SOURCES.dhscDolsGuidance,
  },
} as const;

/** Whether the review-of-existing-authorisations workflow is switched on for a location. */
export function legalChangeReviewEnabled(
  flags: readonly FlagRow[],
  locationId: string | null,
  nation: string,
): boolean {
  return (
    (DOLS_NATIONS as readonly string[]).includes(nation) &&
    evaluateFlag(DOLS_LEGAL_CHANGE.flag, flags, locationId)
  );
}

/** The DHSC guidance's multifactorial assessment, in its words ("Assessing deprivation of liberty"). */
export const MULTIFACTORIAL_FACTORS = [
  {
    key: "type",
    wording:
      "the type of restrictions (for example, locked doors, physical control, supervision, sedating medication, social isolation and so on)",
  },
  { key: "duration", wording: "the duration of those restrictions" },
  { key: "effects", wording: "the effects of the restrictions on the person" },
  { key: "manner", wording: "the manner of implementation of the restrictions" },
  {
    key: "prison_cell_comparison",
    wording: "how far removed the case is from the situation of detention in a prison cell",
  },
  { key: "normality", wording: "the relative normality of the arrangements" },
  {
    key: "purpose",
    wording:
      "the purpose of the arrangement, for example whether the arrangements are for care and protection, rather than punishment or coercion",
  },
] as const;

export type MultifactorialFactor = (typeof MULTIFACTORIAL_FACTORS)[number]["key"];

/** Forms objection can take, from the DHSC guidance ("Determining objection"). */
export const OBJECTION_FORMS = [
  "attempts_to_leave",
  "refusing_care_or_treatment",
  "restraint_or_one_to_one_care",
  "covert_medication",
  "sedating_medication",
] as const;
export type ObjectionForm = (typeof OBJECTION_FORMS)[number];

export type LegalChangeDecision = "still_deprived" | "no_longer_deprived" | "in_doubt";

export interface LegalChangeReviewInput {
  /** What was found for each factor. */
  readonly factors: Partial<Record<MultifactorialFactor, string>>;
  /** "whether the person objects". */
  readonly objection: "objects" | "does_not_object" | "fluctuates" | "unclear" | null;
  readonly objectionForms: readonly ObjectionForm[];
  /**
   * The guidance: "A person can give valid consent if they are conscious of their environment,
   * have a basic level of understanding and are capable of expressing a view that they accept
   * and/or are happy with the situation. However, if there is serious doubt, no conclusion of
   * valid consent can be drawn".
   */
  readonly consent: {
    readonly consciousOfEnvironment: boolean | null;
    readonly basicUnderstanding: boolean | null;
    readonly expressesAcceptance: boolean | null;
    readonly seriousDoubt: boolean | null;
  };
  readonly decision: LegalChangeDecision | null;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  /** The request to the supervisory body (local authority) for a review, when one is made. */
  readonly referral: { readonly sentAt: Date; readonly reference: string | null } | null;
}

export interface LegalChangeReviewCheck {
  readonly ok: boolean;
  readonly issues: readonly InputIssue[];
  /** A referral to the local authority is needed before the review can close. */
  readonly referralRequired: boolean;
  /** Quoted points from the guidance that apply to these answers. */
  readonly prompts: readonly string[];
  /** The guidance's signs of valid consent are all recorded and nothing casts serious doubt. */
  readonly consentSignsRecorded: boolean;
}

/**
 * Checks a review of an existing authorisation (the decision is the reviewer's; Harbour records
 * it and says when the local authority must be asked). The managing authority may ask the
 * supervisory body for a review at any time and must when a qualifying requirement appears
 * reviewable (Schedule A1 para 103); only the supervisory body ends an authorisation (para 117).
 */
export function checkLegalChangeReview(input: LegalChangeReviewInput): LegalChangeReviewCheck {
  const issues: InputIssue[] = [];
  for (const factor of MULTIFACTORIAL_FACTORS) {
    if (!(input.factors[factor.key]?.trim() ?? "")) {
      issues.push(issue(`factors.${factor.key}`, "missing", `Record ${factor.wording}.`));
    }
  }
  if (input.objection === null) {
    issues.push(issue("objection", "missing", "Record whether the person objects."));
  }
  for (const [key, value] of Object.entries(input.consent)) {
    if (value === null)
      issues.push(issue(`consent.${key}`, "missing", "Answer each question about consent."));
  }
  if (input.decision === null) issues.push(issue("decision", "missing", "Record the decision."));
  if (!input.decidedAt)
    issues.push(issue("decidedAt", "missing", "Record the date of the decision."));
  if (!(input.decidedBy?.trim() ?? ""))
    issues.push(issue("decidedBy", "missing", "Record who decided."));

  const prompts: string[] = [];
  const objectionInDoubt = input.objection === "fluctuates" || input.objection === "unclear";
  if (objectionInDoubt) {
    prompts.push(
      "Where practitioners are in doubt about whether someone is objecting, or the person fluctuates between appearing content and appearing to object, a referral should be made to the local authority (DHSC guidance).",
    );
  }
  if (input.objection === "objects") {
    prompts.push("Any objection would point towards a deprivation of liberty (DHSC guidance).");
  }
  if (input.consent.seriousDoubt === true) {
    prompts.push(
      "If there is serious doubt, no conclusion of valid consent can be drawn (DHSC guidance).",
    );
  }
  const c = input.consent;
  const consentSignsRecorded =
    c.consciousOfEnvironment === true &&
    c.basicUnderstanding === true &&
    c.expressesAcceptance === true &&
    c.seriousDoubt === false &&
    input.objection === "does_not_object";
  const referralRequired =
    input.decision === "no_longer_deprived" || input.decision === "in_doubt" || objectionInDoubt;
  if (input.decision === "no_longer_deprived") {
    prompts.push(
      "Ask the local authority (the supervisory body) to review the authorisation: only it can end the authorisation (Mental Capacity Act 2005 Schedule A1 para 103 and para 117).",
    );
  }
  return { ok: issues.length === 0, issues, referralRequired, prompts, consentSignsRecorded };
}

export type LegalChangeReviewState = "awaiting_review" | "reviewed" | "referred" | "closed";

/**
 * Review of an existing authorisation after the 2026 judgment. `reviewed` records the
 * multifactorial assessment and decision (`checkLegalChangeReview` must pass); `referred` records
 * the request to the local authority; `closed` records the local authority's response, that the
 * authorisation continues to its end date, or that it ended before the review.
 */
export const DOLS_LEGAL_CHANGE_REVIEW_WORKFLOW = defineWorkflow<LegalChangeReviewState>({
  key: "care.dols_legal_change_review",
  version: 1,
  states: ["awaiting_review", "reviewed", "referred", "closed"],
  initial: "awaiting_review",
  terminal: ["closed"],
  transitions: [
    { from: "awaiting_review", to: "reviewed", permission: "care.dols.manage" },
    { from: "reviewed", to: "referred", permission: "care.dols.manage" },
    { from: "reviewed", to: "closed", permission: "care.dols.manage", requiresReason: true },
    { from: "referred", to: "closed", permission: "care.dols.manage", requiresReason: true },
    { from: "awaiting_review", to: "closed", permission: "care.dols.manage", requiresReason: true },
  ],
});

export type LegalChangeStepProblem =
  | "review_incomplete"
  | "referral_required"
  | "referral_missing"
  | "authorisation_still_in_force";

/**
 * The data each step of the review needs, beyond the workflow's permission and reason checks.
 * `endsAt` is when the authorisation ends (closing without a review is allowed only after that).
 */
export function legalChangeStepProblems(
  from: LegalChangeReviewState,
  to: LegalChangeReviewState,
  review: LegalChangeReviewInput,
  authorisationEndedAt: Date | null,
  at: Date,
): LegalChangeStepProblem[] {
  const check = checkLegalChangeReview(review);
  if (to === "reviewed") return check.ok ? [] : ["review_incomplete"];
  if (to === "referred") return review.referral ? [] : ["referral_missing"];
  if (to === "closed" && from === "reviewed" && check.referralRequired)
    return ["referral_required"];
  if (to === "closed" && from === "awaiting_review") {
    const ended = authorisationEndedAt !== null && authorisationEndedAt.getTime() <= at.getTime();
    return ended ? [] : ["authorisation_still_in_force"];
  }
  return [];
}

export interface AwaitingReview {
  readonly authorisation: DolsAuthorisationView;
  readonly endsAt: Date | null;
}

/**
 * Authorisations granted before the judgment that are still in force and have no review yet,
 * soonest ending first (DHSC: local authorities should prioritise "cases coming to the end of
 * their authorisation"). HZ-020: every one is listed until reviewed.
 */
export function authorisationsAwaitingLegalChangeReview(
  authorisations: readonly (DolsAuthorisationView & {
    readonly legalChangeReview: LegalChangeReviewState | null;
  })[],
  rates: DolsRates,
  at: Date,
): AwaitingReview[] {
  const judgment = ukStartOfDay(DOLS_LEGAL_CHANGE.judgment.decidedOn);
  return authorisations
    .filter((a) => a.legalChangeReview === null || a.legalChangeReview === "awaiting_review")
    .filter((a) => a.grantedFrom !== null && a.grantedFrom.getTime() < judgment.getTime())
    .filter((a) => {
      const status = dolsStatus(a, rates, at).status;
      return status === "active" || status === "expiring";
    })
    .map((a) => ({ authorisation: a, endsAt: dolsEndsAt(a) }))
    .sort(
      (x, y) =>
        (x.endsAt?.getTime() ?? Number.POSITIVE_INFINITY) -
        (y.endsAt?.getTime() ?? Number.POSITIVE_INFINITY),
    );
}
