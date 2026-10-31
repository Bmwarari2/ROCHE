import { addUkMonths, ukEndOfDay } from "../shared/time";
import { ukIsoDate } from "../shared/working-days";
import { isCalendarDate } from "./dates";
import { LIVE_PERSON_STATUSES, type PersonStatus } from "./lifecycle";

/**
 * Family and professional sharing (master prompt sections 9.2 and 15.1; Caldicott principle 7;
 * people.md section 4 rule 13; hazard HZ-022). Every section of a person's record is closed to
 * family members, representatives, external professionals and share links until a recorded
 * sharing decision covers that section for that recipient, rests on a valid basis (the person's
 * consent, a legal authority, a best-interests decision, or direct care for professionals), and
 * is in force: started, not expired, not withdrawn or suspended. Every decision expires, at most
 * `sharing.decision_max_months` after it starts and never after the authority it rests on ends,
 * and is renewed at review (H-38). Sharing closes when the person leaves the service or dies.
 */

export const SHARING_SECTIONS = [
  "about_me",
  "daily_updates",
  "photos",
  "activities_and_visits",
  "care_plan",
  "health_summary",
  "medicines",
  "appointments",
  "finance",
  "benefits",
  "documents",
] as const;
export type SharingSection = (typeof SHARING_SECTIONS)[number];

/** Sections a professional may see for direct care without the person's consent (Caldicott 7). */
export const DIRECT_CARE_SECTIONS: readonly SharingSection[] = [
  "about_me",
  "daily_updates",
  "care_plan",
  "health_summary",
  "medicines",
  "appointments",
];

/** Sections that only a property-and-finance authority covers (an appointee: benefits only). */
export const FINANCE_SECTIONS: readonly SharingSection[] = ["finance", "benefits"];

/** A DWP appointee acts for social security benefits only, not the person's wider finances. */
export const APPOINTEE_SECTIONS: readonly SharingSection[] = ["benefits"];

export const SHARING_BASES = [
  "consent",
  "legal_authority",
  "best_interests",
  "direct_care",
] as const;
export type SharingBasis = (typeof SHARING_BASES)[number];

export type SharingRecipient =
  | { readonly kind: "family"; readonly contactId: string }
  | { readonly kind: "professional"; readonly tenantUserId: string }
  | { readonly kind: "link"; readonly linkId: string };

export const AUTHORITY_ROLES = [
  "lpa_health_welfare",
  "lpa_property_finance",
  "deputy_personal_welfare",
  "deputy_property_affairs",
  "appointee",
] as const;
export type AuthorityRole = (typeof AUTHORITY_ROLES)[number];

const WELFARE_AUTHORITIES: readonly AuthorityRole[] = [
  "lpa_health_welfare",
  "deputy_personal_welfare",
];

const DEPUTY_AUTHORITIES: readonly AuthorityRole[] = [
  "deputy_personal_welfare",
  "deputy_property_affairs",
];

export interface SharingAuthority {
  readonly role: AuthorityRole;
  /** The contact who holds it. */
  readonly contactId: string;
  /** Office of the Public Guardian, court or DWP reference. */
  readonly reference: string | null;
  readonly evidenceDocumentId: string | null;
  /** yyyy-mm-dd; null when the authority has no end date. */
  readonly validUntil: string | null;
  /**
   * For a deputy: the sections the Court of Protection order covers, as recorded from the order
   * (MCA 2005 s.16 and s.20: a deputy acts only within the powers given). Required for deputies.
   */
  readonly orderSections?: readonly SharingSection[] | null;
}

/** The person's capacity for this decision. Capacity is presumed (MCA 2005 s.1(2)). */
export type CapacityForSharing = "presumed" | "assessed_has_capacity" | "assessed_lacks_capacity";

/** A period when sharing under a decision was suspended (for example a safeguarding enquiry). */
export interface SharingSuspension {
  readonly from: Date;
  /** Null while the suspension lasts. */
  readonly to: Date | null;
}

export interface SharingDecision {
  readonly id: string;
  readonly personId: string;
  readonly recipient: SharingRecipient;
  readonly sections: readonly string[];
  /** Care plan domains shared when `care_plan` is a section; "all" or omitted means every domain. */
  readonly carePlanDomains?: readonly string[] | "all";
  readonly basis: SharingBasis;
  /** For consent: given by the person, or by an attorney or deputy whose authority covers it. */
  readonly consentGivenBy?: "person" | "authority_holder" | null;
  readonly capacity: CapacityForSharing;
  readonly bestInterestsDecisionId?: string | null;
  readonly authority?: SharingAuthority | null;
  readonly validFrom: Date;
  /** Every decision expires (access expiry, section 9.2). */
  readonly validTo: Date;
  readonly withdrawnAt: Date | null;
  /** An open-ended suspension; `suspensions` records periods that have ended as well. */
  readonly suspendedAt: Date | null;
  readonly suspensions?: readonly SharingSuspension[];
}

export type SharingDecisionProblem =
  | "no_sections"
  | "unknown_section"
  | "duplicate_section"
  | "care_plan_domains_without_care_plan"
  | "expiry_before_start"
  | "expiry_in_past"
  | "expiry_beyond_maximum"
  | "expiry_beyond_authority"
  | "person_record_not_live"
  | "consent_giver_required"
  | "person_lacks_capacity"
  | "authority_required"
  | "authority_not_recipient"
  | "authority_evidence_required"
  | "authority_expired"
  | "authority_does_not_cover_section"
  | "authority_needs_lack_of_capacity"
  | "deputy_order_scope_required"
  | "best_interests_decision_required"
  | "best_interests_needs_lack_of_capacity"
  | "direct_care_professionals_only"
  | "direct_care_section_not_clinical"
  | "link_only_about_me"
  | "link_not_direct_care"
  | "suspension_ends_before_start";

function isSection(value: string): value is SharingSection {
  return (SHARING_SECTIONS as readonly string[]).includes(value);
}

function authorityCovers(authority: SharingAuthority, section: SharingSection): boolean {
  const { role } = authority;
  if (role === "appointee") return APPOINTEE_SECTIONS.includes(section);
  const finance = FINANCE_SECTIONS.includes(section);
  const withinRole =
    role === "lpa_property_finance" || role === "deputy_property_affairs" ? finance : !finance;
  if (!withinRole) return false;
  if (DEPUTY_AUTHORITIES.includes(role)) return authority.orderSections?.includes(section) === true;
  return true;
}

function authorityProblems(
  decision: SharingDecision,
  sections: readonly SharingSection[],
): SharingDecisionProblem[] {
  const authority = decision.authority;
  if (!authority) return ["authority_required"];
  const problems: SharingDecisionProblem[] = [];
  if (!authority.evidenceDocumentId && !authority.reference)
    problems.push("authority_evidence_required");
  if (DEPUTY_AUTHORITIES.includes(authority.role) && !authority.orderSections?.length) {
    problems.push("deputy_order_scope_required");
  }
  if (sections.some((s) => !authorityCovers(authority, s)))
    problems.push("authority_does_not_cover_section");
  // A health and welfare attorney or deputy acts only when the person lacks capacity for the decision.
  if (
    WELFARE_AUTHORITIES.includes(authority.role) &&
    decision.capacity !== "assessed_lacks_capacity"
  ) {
    problems.push("authority_needs_lack_of_capacity");
  }
  return problems;
}

/** Rules that hold whatever the time: a stored decision failing any of them is never honoured. */
function structuralProblems(decision: SharingDecision): SharingDecisionProblem[] {
  const problems: SharingDecisionProblem[] = [];
  if (decision.sections.length === 0) problems.push("no_sections");
  if (decision.sections.some((s) => !isSection(s))) problems.push("unknown_section");
  if (new Set(decision.sections).size !== decision.sections.length)
    problems.push("duplicate_section");
  const sections = decision.sections.filter(isSection);
  if (
    Array.isArray(decision.carePlanDomains) &&
    decision.carePlanDomains.length > 0 &&
    !sections.includes("care_plan")
  ) {
    problems.push("care_plan_domains_without_care_plan");
  }
  if (decision.validTo.getTime() <= decision.validFrom.getTime())
    problems.push("expiry_before_start");
  if ((decision.suspensions ?? []).some((s) => s.to !== null && s.to.getTime() <= s.from.getTime()))
    problems.push("suspension_ends_before_start");

  const { recipient, basis } = decision;
  if (recipient.kind === "link") {
    if (sections.some((s) => s !== "about_me")) problems.push("link_only_about_me");
    if (basis === "direct_care") problems.push("link_not_direct_care");
  }
  switch (basis) {
    case "consent":
      if (!decision.consentGivenBy) problems.push("consent_giver_required");
      else if (decision.consentGivenBy === "person") {
        if (decision.capacity === "assessed_lacks_capacity") problems.push("person_lacks_capacity");
      } else {
        problems.push(...authorityProblems(decision, sections));
      }
      break;
    case "legal_authority":
      problems.push(...authorityProblems(decision, sections));
      if (
        decision.authority &&
        (recipient.kind !== "family" || recipient.contactId !== decision.authority.contactId)
      ) {
        problems.push("authority_not_recipient");
      }
      break;
    case "best_interests":
      if (!decision.bestInterestsDecisionId) problems.push("best_interests_decision_required");
      if (decision.capacity !== "assessed_lacks_capacity")
        problems.push("best_interests_needs_lack_of_capacity");
      break;
    case "direct_care":
      if (recipient.kind !== "professional") problems.push("direct_care_professionals_only");
      if (sections.some((s) => !DIRECT_CARE_SECTIONS.includes(s)))
        problems.push("direct_care_section_not_clinical");
      break;
  }
  return problems;
}

function usesAuthority(decision: Pick<SharingDecision, "basis" | "consentGivenBy">): boolean {
  return (
    decision.basis === "legal_authority" ||
    (decision.basis === "consent" && decision.consentGivenBy === "authority_holder")
  );
}

function authorityLapsed(decision: SharingDecision, now: Date): boolean {
  const until = decision.authority?.validUntil ?? null;
  return (
    usesAuthority(decision) && until !== null && (!isCalendarDate(until) || until < ukIsoDate(now))
  );
}

/**
 * Whether the decision would outlast the authority it rests on: it may run to the end of the
 * authority's last day (UK time), never beyond (H-38).
 */
function outlastsAuthority(decision: SharingDecision): boolean {
  const until = decision.authority?.validUntil ?? null;
  if (!usesAuthority(decision) || until === null || !isCalendarDate(until)) return false;
  return decision.validTo.getTime() > ukEndOfDay(until).getTime();
}

/**
 * True when the decision rests on the person lacking capacity for it: a welfare attorney or
 * deputy's authority, a representative's consent, or a best-interests decision. Such a decision
 * applies only while the person still lacks capacity (MCA 2005 s.11(7)(a), s.20(1)).
 */
export function decisionNeedsLackOfCapacity(decision: SharingDecision): boolean {
  if (decision.basis === "best_interests") return true;
  if (decision.basis === "consent") return decision.consentGivenBy === "authority_holder";
  if (decision.basis === "legal_authority") {
    return decision.authority ? WELFARE_AUTHORITIES.includes(decision.authority.role) : false;
  }
  return false;
}

/** Whether sharing under the decision was suspended at an instant. */
export function isSharingSuspendedAt(decision: SharingDecision, at: Date): boolean {
  const t = at.getTime();
  if (decision.suspendedAt && decision.suspendedAt.getTime() <= t) return true;
  return (decision.suspensions ?? []).some(
    (s) => s.from.getTime() <= t && (s.to === null || s.to.getTime() > t),
  );
}

export type SharingDecisionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly SharingDecisionProblem[] };

/**
 * Checks a sharing decision before it is recorded. `maxMonths` is the rate table's
 * `sharing.decision_max_months`: a decision ends no later than that many calendar months after it
 * starts (UK wall clock), and no later than the end of the authority it rests on, so it is renewed
 * at review rather than left open (H-38; HZ-022). Decisions recorded before the limit keep their
 * own end date.
 */
export function checkSharingDecision(
  decision: SharingDecision,
  context: { readonly personStatus: PersonStatus; readonly now: Date; readonly maxMonths: number },
): SharingDecisionCheck {
  if (!Number.isInteger(context.maxMonths) || context.maxMonths < 1) {
    throw new RangeError("The longest a sharing decision may last is a whole number of months.");
  }
  const problems = structuralProblems(decision);
  if (decision.validTo.getTime() <= context.now.getTime()) problems.push("expiry_in_past");
  if (decision.validTo.getTime() > addUkMonths(decision.validFrom, context.maxMonths).getTime()) {
    problems.push("expiry_beyond_maximum");
  }
  if (!LIVE_PERSON_STATUSES.includes(context.personStatus)) problems.push("person_record_not_live");
  if (authorityLapsed(decision, context.now)) problems.push("authority_expired");
  else if (outlastsAuthority(decision)) problems.push("expiry_beyond_authority");
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

// ------------------------------------------------------------------------------------------------
// Visibility
// ------------------------------------------------------------------------------------------------

export type HiddenReason =
  | "person_record_closed"
  | "no_decision"
  | "section_not_covered"
  | "withdrawn"
  | "suspended"
  | "authority_lapsed"
  | "capacity_regained"
  | "decision_invalid"
  | "expired"
  | "not_yet_valid";

export type SectionVisibility =
  | { readonly visible: true; readonly decisionId: string; readonly expiresAt: Date }
  | { readonly visible: false; readonly reason: HiddenReason };

export interface SectionVisibilityRequest {
  readonly personId: string;
  readonly personStatus: PersonStatus;
  readonly recipient: SharingRecipient;
  readonly section: SharingSection;
  /** For the care plan: the domain being shown. */
  readonly carePlanDomain?: string | null;
  /**
   * The person's capacity for the sharing decision now, from the latest assessment. Omitted means
   * presumed (MCA 2005 s.1(2)), so a decision that needs a lack of capacity stays closed.
   */
  readonly capacityNow?: CapacityForSharing;
  readonly now: Date;
}

const HIDDEN_PRIORITY: readonly HiddenReason[] = [
  "withdrawn",
  "suspended",
  "authority_lapsed",
  "capacity_regained",
  "decision_invalid",
  "expired",
  "not_yet_valid",
];

function sameRecipient(a: SharingRecipient, b: SharingRecipient): boolean {
  if (a.kind === "family" && b.kind === "family") return a.contactId === b.contactId;
  if (a.kind === "professional" && b.kind === "professional")
    return a.tenantUserId === b.tenantUserId;
  if (a.kind === "link" && b.kind === "link") return a.linkId === b.linkId;
  return false;
}

function coversSection(
  decision: SharingDecision,
  section: SharingSection,
  domain: string | null | undefined,
): boolean {
  if (!decision.sections.includes(section)) return false;
  if (section !== "care_plan" || !domain) return true;
  const domains = decision.carePlanDomains ?? "all";
  return domains === "all" || domains.includes(domain);
}

function decisionState(
  decision: SharingDecision,
  now: Date,
  capacityNow: CapacityForSharing = "presumed",
): HiddenReason | null {
  const t = now.getTime();
  if (decision.withdrawnAt && decision.withdrawnAt.getTime() <= t) return "withdrawn";
  if (isSharingSuspendedAt(decision, now)) return "suspended";
  if (authorityLapsed(decision, now)) return "authority_lapsed";
  if (decisionNeedsLackOfCapacity(decision) && capacityNow !== "assessed_lacks_capacity") {
    return "capacity_regained";
  }
  if (structuralProblems(decision).length > 0) return "decision_invalid";
  if (decision.validTo.getTime() <= t) return "expired";
  if (decision.validFrom.getTime() > t) return "not_yet_valid";
  return null;
}

/**
 * Whether a decision was in force at an earlier instant, judged by its own dates, withdrawal and
 * suspensions (not by capacity or validity, which are judged now). The family feed uses this so
 * that an update from a time the decision did not cover stays closed (comms.md rule 2).
 */
export function decisionInForceAt(
  decision: SharingDecision,
  at: Date,
): "in_force" | "not_yet_valid" | "withdrawn" | "suspended" | "expired" {
  const t = at.getTime();
  if (decision.validFrom.getTime() > t) return "not_yet_valid";
  if (decision.withdrawnAt && decision.withdrawnAt.getTime() <= t) return "withdrawn";
  if (isSharingSuspendedAt(decision, at)) return "suspended";
  if (decision.validTo.getTime() <= t) return "expired";
  return "in_force";
}

/**
 * Whether one section of a person's record may be shown to a recipient now (HZ-022). Closed by
 * default: no decision, or no decision in force for that section, means hidden.
 */
export function checkSectionVisibility(
  decisions: readonly SharingDecision[],
  request: SectionVisibilityRequest,
): SectionVisibility {
  if (!LIVE_PERSON_STATUSES.includes(request.personStatus)) {
    return { visible: false, reason: "person_record_closed" };
  }
  const mine = decisions.filter(
    (d) => d.personId === request.personId && sameRecipient(d.recipient, request.recipient),
  );
  if (mine.length === 0) return { visible: false, reason: "no_decision" };
  const covering = mine.filter((d) => coversSection(d, request.section, request.carePlanDomain));
  if (covering.length === 0) return { visible: false, reason: "section_not_covered" };
  const states = covering.map((d) => ({
    decision: d,
    hidden: decisionState(d, request.now, request.capacityNow),
  }));
  const inForce = states
    .filter((s) => s.hidden === null)
    .sort((a, b) => b.decision.validTo.getTime() - a.decision.validTo.getTime())[0];
  if (inForce) {
    return { visible: true, decisionId: inForce.decision.id, expiresAt: inForce.decision.validTo };
  }
  const reasons = new Set(states.map((s) => s.hidden));
  const reason = HIDDEN_PRIORITY.find((r) => reasons.has(r)) ?? "decision_invalid";
  return { visible: false, reason };
}

/** The sections a recipient may see now; everything else stays closed. */
export function visibleSharingSections(
  decisions: readonly SharingDecision[],
  request: Omit<SectionVisibilityRequest, "section" | "carePlanDomain">,
): SharingSection[] {
  return SHARING_SECTIONS.filter(
    (section) => checkSectionVisibility(decisions, { ...request, section }).visible,
  );
}

// ------------------------------------------------------------------------------------------------
// A change to the contact who holds an authority (PEOP-001 with rule 13; HZ-022, fail closed)
// ------------------------------------------------------------------------------------------------

/** The contact role that holds each authority. */
export const AUTHORITY_CONTACT_ROLES: Readonly<Record<AuthorityRole, string>> = {
  lpa_health_welfare: "lpa_health_welfare",
  lpa_property_finance: "lpa_property_finance",
  deputy_personal_welfare: "deputy",
  deputy_property_affairs: "deputy",
  appointee: "appointee",
};

/** The deputyships (`contact.authority_scope`) that allow each deputy authority. */
export const DEPUTY_SCOPES: Readonly<Partial<Record<AuthorityRole, readonly string[]>>> = {
  deputy_personal_welfare: ["personal_welfare", "both"],
  deputy_property_affairs: ["property_affairs", "both"],
};

/** The contact holding an authority, as it is after a change (or removed). */
export interface AuthorityHolder {
  readonly role: string;
  readonly authorityScope: string | null;
  readonly reference: string | null;
  readonly documentId: string | null;
  /** yyyy-mm-dd; null when no end date is recorded. */
  readonly validUntil: string | null;
  readonly removed: boolean;
}

export type AuthorityChange =
  | "holder_removed"
  | "role_changed"
  | "order_scope_changed"
  | "evidence_removed"
  | "ends_earlier";

/**
 * What a change to the contact who holds a decision's authority takes away from the decision
 * (HZ-022): the contact removed; no longer holding that kind of authority; a deputy's order no
 * longer of that kind; the last reference or evidence removed; or the authority now ending before
 * the end date the decision recorded (or ending at all, when it recorded none). A decision that
 * does not rest on that contact's authority is untouched. Any answer means the decision is
 * suspended at once, until someone reviews it: it never keeps sharing on an authority that has
 * been taken away, whatever its own copy says. Evidence counts as removed only when the contact
 * had some before the change (a decision may carry its own reference).
 */
export function authorityChangeEffects(
  decision: Pick<SharingDecision, "basis" | "consentGivenBy" | "authority">,
  holderId: string,
  before: AuthorityHolder,
  holder: AuthorityHolder,
): AuthorityChange[] {
  return holderProblems(decision, holderId, holder, before);
}

/**
 * Whether the contact a decision's authority rests on still holds it as the decision recorded
 * (HZ-022; #119 review round 2): checked when a suspension is lifted, so a decision suspended for
 * another reason (a safeguarding enquiry) never reopens on an authority that has since been taken
 * away. The decision carries its own evidence, so only the holder, their kind of authority, a
 * deputy's order and the end date are compared. Empty when it still holds, or when the decision
 * rests on no authority.
 */
export function authorityHeldNow(
  decision: Pick<SharingDecision, "basis" | "consentGivenBy" | "authority">,
  holderId: string,
  holder: AuthorityHolder,
): AuthorityChange[] {
  return holderProblems(decision, holderId, holder, null);
}

function holderProblems(
  decision: Pick<SharingDecision, "basis" | "consentGivenBy" | "authority">,
  holderId: string,
  holder: AuthorityHolder,
  /** The contact before a change, to tell evidence removed from evidence never there. */
  before: AuthorityHolder | null,
): AuthorityChange[] {
  const authority = decision.authority;
  if (!usesAuthority(decision) || !authority || authority.contactId !== holderId) return [];
  if (holder.removed) return ["holder_removed"];
  const changes: AuthorityChange[] = [];
  if (holder.role !== AUTHORITY_CONTACT_ROLES[authority.role]) changes.push("role_changed");
  const scopes = DEPUTY_SCOPES[authority.role];
  if (scopes && (!holder.authorityScope || !scopes.includes(holder.authorityScope))) {
    changes.push("order_scope_changed");
  }
  const hadEvidence = before !== null && Boolean(before.reference || before.documentId);
  if (hadEvidence && !holder.reference && !holder.documentId) changes.push("evidence_removed");
  if (
    holder.validUntil !== null &&
    (authority.validUntil === null || holder.validUntil < authority.validUntil)
  ) {
    changes.push("ends_earlier");
  }
  return changes;
}

// ------------------------------------------------------------------------------------------------
// About Me share links (PRSB: shareable by link with consent)
// ------------------------------------------------------------------------------------------------

export type AboutMeLinkProblem =
  | "not_a_link_decision"
  | "about_me_not_covered"
  | "decision_not_in_force"
  | "link_expiry_in_past"
  | "link_outlives_decision";

export type AboutMeLinkCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: readonly AboutMeLinkProblem[] };

/** Checks a request for an expiring About Me link against the decision that allows it. */
export function checkAboutMeShareLink(
  decision: SharingDecision,
  request: {
    readonly personStatus: PersonStatus;
    readonly linkExpiresAt: Date;
    readonly now: Date;
    /** The person's capacity for the sharing decision now (presumed when omitted). */
    readonly capacityNow?: CapacityForSharing;
  },
): AboutMeLinkCheck {
  const problems: AboutMeLinkProblem[] = [];
  if (decision.recipient.kind !== "link") problems.push("not_a_link_decision");
  if (!decision.sections.includes("about_me")) problems.push("about_me_not_covered");
  if (
    !LIVE_PERSON_STATUSES.includes(request.personStatus) ||
    decisionState(decision, request.now, request.capacityNow) !== null
  ) {
    problems.push("decision_not_in_force");
  }
  if (request.linkExpiresAt.getTime() <= request.now.getTime())
    problems.push("link_expiry_in_past");
  else if (request.linkExpiresAt.getTime() > decision.validTo.getTime())
    problems.push("link_outlives_decision");
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
