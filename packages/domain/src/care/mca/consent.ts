/**
 * Consent records (care.md section 2 `consent_record` and section 4; CARE-021; master prompt 10.4
 * and 5.1). Consent is per decision, given by the person or by a representative whose authority
 * covers that decision, and it can expire or be withdrawn. Consent is never the lawful basis for
 * the care record itself (master prompt 5.1); these rules cover the decisions that need it.
 *
 * Mental Capacity Act 2005 (legislation.gov.uk, read 11 October 2026):
 * - s.1(2) a person must be assumed to have capacity unless it is established that they lack it;
 * - s.9(1) a lasting power of attorney covers personal welfare, property and affairs, or both, and
 *   s.9(2)(b) it is not created until it is registered;
 * - s.11(7)(a) a personal welfare attorney may decide only where the person lacks, or the attorney
 *   reasonably believes they lack, capacity; s.11(7)(c) the authority extends to consent to
 *   treatment; s.11(1) to (5) an attorney may not restrain the person unless three conditions hold;
 * - s.20(1) a deputy has no power where the person has capacity; s.16 and s.20 a deputy acts only
 *   within the powers the Court of Protection gave; s.20(7) to (11) restraint needs express authority.
 * NICE SC1 (2014) 1.15.1: no covert administration "if the resident has capacity to make decisions
 * about their treatment and care"; 1.15.3: covert administration needs a best interest meeting.
 */

import { type Citation, cite, SOURCES } from "../../shared/citation";

export const CONSENT_DECISION_KINDS = [
  "care_plan",
  "photos",
  "social_media",
  "sharing",
  "marketing",
  "ai_processing",
  "bed_rails",
  "covert_medicines",
] as const;

export type ConsentDecisionKind = (typeof CONSENT_DECISION_KINDS)[number];

export interface ConsentDecisionRule {
  readonly label: string;
  /** A personal welfare matter (MCA 2005 s.9(1)(a)) that a welfare attorney or deputy may decide. */
  readonly personalWelfare: boolean;
  /** False where only the person may consent; `representativeNote` says why. */
  readonly representativeMayConsent: boolean;
  readonly representativeNote: string | null;
  /** Restricts the person's liberty of movement (MCA 2005 s.11(5), s.20(12)). */
  readonly mayRestrain: boolean;
  /** Only for a person who lacks capacity for the decision (NICE SC1 1.15.1). */
  readonly onlyWhenPersonLacksCapacity: boolean;
  /** Needs a recorded best-interests decision as well as consent (NICE SC1 1.15.3). */
  readonly needsBestInterestsDecision: boolean;
  readonly sources: readonly Citation[];
}

const MP = (section: string): Citation =>
  cite("Harbour master prompt", section, "docs/00-MASTER-PROMPT.md");

/** Master prompt 10.4 lists the first six kinds; 5.1 adds marketing and 9.2 social media. */
export const CONSENT_DECISIONS: Readonly<Record<ConsentDecisionKind, ConsentDecisionRule>> = {
  care_plan: {
    label: "Care and support plan",
    personalWelfare: true,
    representativeMayConsent: true,
    representativeNote: null,
    mayRestrain: false,
    onlyWhenPersonLacksCapacity: false,
    needsBestInterestsDecision: false,
    sources: [MP("10.4")],
  },
  photos: {
    label: "Photographs in the care record and family portal",
    personalWelfare: true,
    representativeMayConsent: true,
    representativeNote: null,
    mayRestrain: false,
    onlyWhenPersonLacksCapacity: false,
    needsBestInterestsDecision: false,
    sources: [MP("10.4"), MP("5.1")],
  },
  social_media: {
    label: "Photographs on social media",
    personalWelfare: true,
    representativeMayConsent: true,
    representativeNote: null,
    mayRestrain: false,
    onlyWhenPersonLacksCapacity: false,
    needsBestInterestsDecision: false,
    sources: [MP("9.2")],
  },
  sharing: {
    label: "Sharing information with family and professionals",
    personalWelfare: true,
    representativeMayConsent: true,
    representativeNote: null,
    mayRestrain: false,
    onlyWhenPersonLacksCapacity: false,
    needsBestInterestsDecision: false,
    sources: [MP("10.4")],
  },
  marketing: {
    label: "Marketing",
    personalWelfare: false,
    representativeMayConsent: false,
    representativeNote:
      "Only the person can agree to marketing. It is optional processing, not a decision about their care.",
    mayRestrain: false,
    onlyWhenPersonLacksCapacity: false,
    needsBestInterestsDecision: false,
    sources: [MP("5.1")],
  },
  ai_processing: {
    label: "AI processing of free text",
    personalWelfare: false,
    representativeMayConsent: false,
    representativeNote:
      "Only the person can agree to AI processing until the data protection lead decides how it works for people who lack capacity (human action H-34).",
    mayRestrain: false,
    onlyWhenPersonLacksCapacity: false,
    needsBestInterestsDecision: false,
    sources: [MP("5.1"), MP("10.4")],
  },
  bed_rails: {
    label: "Bed rails",
    personalWelfare: true,
    representativeMayConsent: true,
    representativeNote: null,
    mayRestrain: true,
    onlyWhenPersonLacksCapacity: false,
    needsBestInterestsDecision: false,
    sources: [MP("10.4"), cite("Mental Capacity Act 2005", "s.11(1) to (5)", SOURCES.mcaS11)],
  },
  covert_medicines: {
    label: "Covert administration of medicines",
    personalWelfare: true,
    representativeMayConsent: true,
    representativeNote: null,
    mayRestrain: false,
    onlyWhenPersonLacksCapacity: true,
    needsBestInterestsDecision: true,
    sources: [
      MP("10.2, 10.4"),
      cite("NICE SC1", "1.15.1 and 1.15.3", "https://www.nice.org.uk/guidance/sc1"),
    ],
  },
};

/** The kinds of people who may appear as a representative (master prompt 9.2 legal representatives). */
export type RepresentativeAuthority =
  | {
      readonly kind: "lpa_health_welfare";
      /** MCA 2005 s.9(2)(b): no authority until the Office of the Public Guardian registers it. */
      readonly registered: boolean;
      /** Decisions the instrument excludes or restricts (s.9(4)(b)). */
      readonly excludedDecisions?: readonly ConsentDecisionKind[];
      readonly opgReference?: string | null;
    }
  | {
      readonly kind: "lpa_property_financial";
      readonly registered: boolean;
      readonly opgReference?: string | null;
    }
  | {
      readonly kind: "deputy";
      readonly scope: "personal_welfare" | "property_and_affairs";
      /** The decisions the Court of Protection order covers. */
      readonly decisions: readonly ConsentDecisionKind[];
      /** s.20(8): restraint only where the court expressly conferred it. */
      readonly restraintExpresslyAuthorised?: boolean;
      /** When the order ends, if it is time-limited. */
      readonly orderEndsAt?: Date | null;
      readonly courtReference?: string | null;
    }
  | { readonly kind: "appointee" }
  | { readonly kind: "imca" }
  | { readonly kind: "advocate" }
  | { readonly kind: "family_or_friend" };

export type RepresentativeKind = RepresentativeAuthority["kind"];

export type ConsentGiver =
  | { readonly kind: "person" }
  | { readonly kind: "representative"; readonly authority: RepresentativeAuthority };

/** The person's capacity for this decision when consent was recorded (MCA 2005 s.1(2)). */
export type CapacityAtConsent =
  | { readonly status: "assumed" }
  | { readonly status: "has_capacity"; readonly assessmentId: string }
  | { readonly status: "lacks_capacity"; readonly assessmentId: string };

export interface RestraintConditions {
  /** s.11(3), s.20(10): reasonably believed necessary to prevent harm to the person. */
  readonly necessaryToPreventHarm: boolean;
  /** s.11(4), s.20(11): a proportionate response to the likelihood and seriousness of harm. */
  readonly proportionate: boolean;
}

export interface ConsentRecordView {
  readonly id: string;
  readonly decision: ConsentDecisionKind;
  readonly outcome: "given" | "refused";
  readonly givenBy: ConsentGiver;
  readonly capacity: CapacityAtConsent;
  readonly givenAt: Date;
  readonly expiresAt: Date | null;
  readonly withdrawnAt: Date | null;
  /** Document or note showing how the decision was made. */
  readonly evidence: string | null;
  readonly restraintConditions?: RestraintConditions | null;
  readonly bestInterestsDecisionId?: string | null;
}

export type ConsentProblem =
  | "no_record"
  | "not_yet_given"
  | "withdrawn"
  | "expired"
  | "evidence_missing"
  | "person_lacks_capacity"
  | "covert_needs_lack_of_capacity"
  | "best_interests_decision_missing"
  | "representative_not_permitted"
  | "representative_has_no_authority"
  | "representative_needs_lack_of_capacity"
  | "person_has_capacity_now"
  | "lpa_not_registered"
  | "lpa_excludes_decision"
  | "lpa_wrong_kind"
  | "deputy_order_does_not_cover"
  | "deputy_order_ended"
  | "restraint_conditions_missing"
  | "restraint_not_authorised";

export interface ConsentIssue {
  readonly problem: ConsentProblem;
  readonly message: string;
  readonly source: Citation | null;
}

const MCA = (provision: string, url: string = SOURCES.mca) =>
  cite("Mental Capacity Act 2005", provision, url);

const ISSUES: Readonly<Record<ConsentProblem, { message: string; source: Citation | null }>> = {
  no_record: { message: "No consent is recorded for this decision.", source: null },
  not_yet_given: { message: "This consent starts later than the time asked about.", source: null },
  withdrawn: { message: "Consent was withdrawn.", source: null },
  expired: { message: "Consent has expired. Ask again.", source: null },
  evidence_missing: { message: "Record how the decision was made.", source: null },
  person_lacks_capacity: {
    message:
      "The person was assessed as lacking capacity for this decision, so their own consent cannot be relied on. Record a best-interests decision, or the decision of a representative with authority.",
    source: MCA("s.2(1)", SOURCES.mcaS2),
  },
  covert_needs_lack_of_capacity: {
    message:
      "Medicines must not be given covertly to a person who has capacity to make decisions about their treatment and care.",
    source: cite("NICE SC1", "1.15.1", "https://www.nice.org.uk/guidance/sc1"),
  },
  best_interests_decision_missing: {
    message:
      "Covert administration needs a best-interests decision with the prescriber and pharmacist.",
    source: cite("NICE SC1", "1.15.3", "https://www.nice.org.uk/guidance/sc1"),
  },
  representative_not_permitted: {
    message: "Only the person can give this consent.",
    source: null,
  },
  representative_has_no_authority: {
    message:
      "This person has no legal authority to consent for an adult. Record their views as part of a best-interests decision instead.",
    source: MCA("s.4(7)", SOURCES.mcaS4),
  },
  representative_needs_lack_of_capacity: {
    message:
      "A representative can decide only when the person lacks capacity for this decision. Assume capacity and ask the person, unless an assessment shows they lack it.",
    source: MCA("s.1(2), s.11(7)(a) and s.20(1)", SOURCES.mcaS1),
  },
  person_has_capacity_now: {
    message:
      "The person now has capacity for this decision, so the representative's consent no longer applies. Ask the person.",
    source: MCA("s.11(7)(a) and s.20(1)", SOURCES.mcaS11),
  },
  lpa_not_registered: {
    message: "A lasting power of attorney has no authority until it is registered.",
    source: MCA("s.9(2)(b)", SOURCES.mcaS9),
  },
  lpa_excludes_decision: {
    message: "The lasting power of attorney excludes or restricts this decision.",
    source: MCA("s.9(4)(b)", SOURCES.mcaS9),
  },
  lpa_wrong_kind: {
    message:
      "A property and financial affairs attorney cannot decide about care. Only a health and welfare attorney can.",
    source: MCA("s.9(1)", SOURCES.mcaS9),
  },
  deputy_order_does_not_cover: {
    message: "The deputy's court order does not cover this decision.",
    source: MCA("s.16 and s.20", SOURCES.mcaS20),
  },
  deputy_order_ended: {
    message: "The deputy's court order has ended.",
    source: MCA("s.16", SOURCES.mca),
  },
  restraint_conditions_missing: {
    message:
      "Bed rails restrict movement. Record why they are necessary to prevent harm and why they are a proportionate response.",
    source: MCA("s.11(1) to (5) and s.20(7) to (11)", SOURCES.mcaS11),
  },
  restraint_not_authorised: {
    message: "A deputy may agree to restraint only where the court order expressly allows it.",
    source: MCA("s.20(8)", SOURCES.mcaS20),
  },
};

function issue(problem: ConsentProblem): ConsentIssue {
  return { problem, ...ISSUES[problem] };
}

function representativeIssues(
  decision: ConsentDecisionKind,
  authority: RepresentativeAuthority,
  at: Date,
): ConsentProblem[] {
  const rule = CONSENT_DECISIONS[decision];
  if (!rule.representativeMayConsent) return ["representative_not_permitted"];
  switch (authority.kind) {
    case "lpa_health_welfare": {
      const problems: ConsentProblem[] = [];
      if (!authority.registered) problems.push("lpa_not_registered");
      if (authority.excludedDecisions?.includes(decision)) problems.push("lpa_excludes_decision");
      return problems;
    }
    case "lpa_property_financial":
      // Every kind a representative may decide is a personal welfare matter (s.9(1)(a)).
      return ["lpa_wrong_kind"];
    case "deputy": {
      const problems: ConsentProblem[] = [];
      if (authority.scope !== "personal_welfare" || !authority.decisions.includes(decision)) {
        problems.push("deputy_order_does_not_cover");
      }
      if (authority.orderEndsAt && authority.orderEndsAt.getTime() <= at.getTime()) {
        problems.push("deputy_order_ended");
      }
      if (rule.mayRestrain && authority.restraintExpresslyAuthorised !== true) {
        problems.push("restraint_not_authorised");
      }
      return problems;
    }
    default:
      // Appointees (benefits only), IMCAs, advocates, family and friends have no power to consent.
      return ["representative_has_no_authority"];
  }
}

/**
 * Checks a consent record when it is made (the API refuses one with problems) and again whenever
 * it is relied on. `at` is the time of the check.
 */
export function checkConsentRecord(
  record: ConsentRecordView,
  at: Date = record.givenAt,
): ConsentIssue[] {
  const rule = CONSENT_DECISIONS[record.decision];
  const problems: ConsentProblem[] = [];
  if (!record.evidence || record.evidence.trim().length === 0) problems.push("evidence_missing");
  const lacksCapacity = record.capacity.status === "lacks_capacity";
  if (record.givenBy.kind === "person") {
    if (lacksCapacity) problems.push("person_lacks_capacity");
    else if (rule.onlyWhenPersonLacksCapacity && record.outcome === "given") {
      problems.push("covert_needs_lack_of_capacity");
    }
  } else {
    problems.push(...representativeIssues(record.decision, record.givenBy.authority, at));
    if (!problems.includes("representative_not_permitted") && !lacksCapacity) {
      problems.push("representative_needs_lack_of_capacity");
    }
  }
  if (record.outcome === "given" && rule.mayRestrain && record.givenBy.kind === "representative") {
    const c = record.restraintConditions;
    if (!c?.necessaryToPreventHarm || !c.proportionate)
      problems.push("restraint_conditions_missing");
  }
  if (
    record.outcome === "given" &&
    rule.needsBestInterestsDecision &&
    lacksCapacity &&
    !record.bestInterestsDecisionId
  ) {
    problems.push("best_interests_decision_missing");
  }
  return [...new Set(problems)].map(issue);
}

/** The person's capacity for the decision at the time asked about, from the latest assessment. */
export type CapacityNow = "assumed" | "has_capacity" | "lacks_capacity";

export type ConsentStatus =
  | { readonly status: "valid"; readonly record: ConsentRecordView }
  | { readonly status: "refused"; readonly record: ConsentRecordView; readonly message: string }
  | {
      readonly status: "none";
      readonly record: ConsentRecordView | null;
      readonly issues: readonly ConsentIssue[];
      readonly message: string;
    };

/**
 * Whether a valid consent exists for a decision at a time, and why not. The latest record for the
 * decision made by then decides (a later refusal or withdrawal replaces an earlier consent).
 */
export function consentStatus(
  records: readonly ConsentRecordView[],
  decision: ConsentDecisionKind,
  at: Date,
  capacityNow: CapacityNow = "assumed",
): ConsentStatus {
  const forDecision = records.filter((r) => r.decision === decision);
  const made = forDecision
    .filter((r) => r.givenAt.getTime() <= at.getTime())
    .sort((a, b) => b.givenAt.getTime() - a.givenAt.getTime());
  const latest = made[0];
  const none = (record: ConsentRecordView | null, problems: ConsentIssue[]): ConsentStatus => ({
    status: "none",
    record,
    issues: problems,
    message: problems.map((p) => p.message).join(" "),
  });
  if (!latest) {
    return none(null, [issue(forDecision.length > 0 ? "not_yet_given" : "no_record")]);
  }
  if (latest.withdrawnAt && latest.withdrawnAt.getTime() <= at.getTime()) {
    return none(latest, [issue("withdrawn")]);
  }
  if (latest.outcome === "refused") {
    const by = latest.givenBy.kind === "person" ? "The person" : "Their representative";
    return {
      status: "refused",
      record: latest,
      message: `${by} refused consent for this decision.`,
    };
  }
  const problems = checkConsentRecord(latest, at);
  if (latest.expiresAt && latest.expiresAt.getTime() <= at.getTime())
    problems.push(issue("expired"));
  if (latest.givenBy.kind === "representative" && capacityNow === "has_capacity") {
    problems.push(issue("person_has_capacity_now"));
  }
  return problems.length > 0 ? none(latest, problems) : { status: "valid", record: latest };
}
