import type {
  AboutMeOut,
  AboutMeShareLinkOut,
  ContactOut,
  CreateSharingDecision,
  SharingDecisionOut,
  SharingSection,
  UpdateAboutMe,
} from "@harbour/contracts";
import { ABOUT_ME_SECTIONS, type AboutMeSectionKey, ukEndOfDay, ukIsoDate } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";

/**
 * Helpers for About Me, its share links and sharing decisions on the web (PEOP-003 and PEOP-013;
 * people.md rules 9 and 13; HZ-022). Pure and unit tested. What is in force is the API's answer
 * (`inForce`, `active`, the visibility check); these only say it in words, read the forms and
 * order the lists. Nothing here opens a section: the API does, closed by default.
 */

type FormValues = Pick<FormData, "get" | "getAll">;
const text = (form: FormValues, name: string) => String(form.get(name) ?? "").trim();

// ------------------------------------------------------------------------------------------------
// About Me (rule 9)
// ------------------------------------------------------------------------------------------------

export const ABOUT_ME_KEYS: readonly AboutMeSectionKey[] = ABOUT_ME_SECTIONS.map((s) => s.key);
/** The API's limit on each part. */
export const ABOUT_ME_TEXT_MAX = 4000;
export const SUPPORTER_MAX = 200;

/** The words of one part, or null when nothing is written there. */
export function aboutMeText(about: AboutMeOut, key: AboutMeSectionKey): string | null {
  const section = about.sections[key] as { text?: string | null } | null | undefined;
  const words = section?.text?.trim();
  return words ? words : null;
}

/** How many pictures or recordings a part refers to (kept as documents, never inline). */
export function aboutMeMediaCount(about: AboutMeOut, key: AboutMeSectionKey): number {
  const section = about.sections[key] as { media?: readonly unknown[] } | null | undefined;
  return section?.media?.length ?? 0;
}

export type AboutMeRead =
  | { readonly ok: true; readonly update: Omit<UpdateAboutMe, "version"> }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/**
 * The About Me form as the API takes it. Each part's words replace the last; pictures and
 * recordings already referenced are kept as they were (this form does not add or remove them).
 * When the person did not write it alone, who supported them is required (rule 9).
 */
export function readAboutMeForm(form: FormValues, current: AboutMeOut, t: Translator): AboutMeRead {
  const errors: Record<string, string> = {};
  const who = text(form, "authoredBy");
  if (who !== "person" && who !== "supported") {
    errors.authoredBy = t("people.aboutMe.form.whoRequired");
  }
  const supporter = text(form, "supporter");
  if (who === "supported" && !supporter) {
    errors.supporter = t("people.aboutMe.form.supporterRequired");
  }
  if (supporter.length > SUPPORTER_MAX) {
    errors.supporter = t("people.aboutMe.form.supporterTooLong", { max: SUPPORTER_MAX });
  }
  const sections: Record<string, unknown> = {};
  for (const key of ABOUT_ME_KEYS) {
    const words = text(form, key);
    if (words.length > ABOUT_ME_TEXT_MAX) {
      errors[key] = t("people.aboutMe.form.tooLong", { max: ABOUT_ME_TEXT_MAX });
    }
    const media = (current.sections[key] as { media?: unknown[] } | null | undefined)?.media;
    if (words || (media && media.length > 0)) {
      sections[key] = { text: words || null, ...(media && media.length > 0 ? { media } : {}) };
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const authoredByPerson = who === "person";
  return {
    ok: true,
    update: {
      sections: {
        ...sections,
        supported_to_write_this_by: authoredByPerson ? null : supporter,
      } as UpdateAboutMe["sections"],
      authoredByPerson,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Sharing decisions (rule 13; HZ-022)
// ------------------------------------------------------------------------------------------------

export const SHARING_SECTION_KEYS = [
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
] as const satisfies readonly SharingSection[];

export type DecisionStatus =
  | "in_force"
  | "suspended"
  | "withdrawn"
  | "expired"
  | "not_started"
  | "not_in_force";

/**
 * A decision's state in words. Withdrawn, suspended, ended or not started yet come from its own
 * dates; otherwise the API's `inForce` decides, so anything else that closes it (the person has
 * left, an authority has lapsed, the capacity finding has changed) reads "not in force", never
 * "in force".
 */
export function decisionStatus(decision: SharingDecisionOut, now: Date): DecisionStatus {
  const t = now.getTime();
  if (decision.withdrawnAt) return "withdrawn";
  if (decision.suspendedAt) return "suspended";
  if (Date.parse(decision.validTo) <= t) return "expired";
  if (Date.parse(decision.validFrom) > t) return "not_started";
  return decision.inForce ? "in_force" : "not_in_force";
}

/** StatusChip status and icon for each decision state: always with the word beside them. */
export const DECISION_CHIPS: Record<
  DecisionStatus,
  {
    readonly status: "done" | "due" | "overdue" | "neutral";
    readonly icon: "circle-check" | "pause" | "circle-x" | "clock" | "ban";
  }
> = {
  in_force: { status: "done", icon: "circle-check" },
  suspended: { status: "due", icon: "pause" },
  withdrawn: { status: "neutral", icon: "circle-x" },
  expired: { status: "neutral", icon: "clock" },
  not_started: { status: "neutral", icon: "clock" },
  not_in_force: { status: "overdue", icon: "ban" },
};

/** Decisions in force first, then suspended or not started, then the rest; newest first in each. */
export function orderDecisions(
  items: readonly SharingDecisionOut[],
  now: Date,
): SharingDecisionOut[] {
  const rank: Record<DecisionStatus, number> = {
    in_force: 0,
    suspended: 1,
    not_started: 1,
    not_in_force: 2,
    expired: 3,
    withdrawn: 3,
  };
  return [...items].sort(
    (a, b) =>
      rank[decisionStatus(a, now)] - rank[decisionStatus(b, now)] ||
      Date.parse(b.validFrom) - Date.parse(a.validFrom),
  );
}

/** What the decision can still have done to it: suspend, lift a suspension, withdraw. */
export function decisionActions(
  decision: SharingDecisionOut,
  now: Date,
): readonly ("suspend" | "lift" | "withdraw")[] {
  const status = decisionStatus(decision, now);
  if (status === "withdrawn" || status === "expired") return [];
  return status === "suspended" ? ["lift", "withdraw"] : ["suspend", "withdraw"];
}

export interface RecipientNames {
  readonly contacts: ReadonlyMap<string, ContactOut>;
  readonly staff: ReadonlyMap<string, string>;
}

/** Who a decision shares with, in words. A contact or member no longer listed is said so. */
export function recipientLabel(
  recipient: SharingDecisionOut["recipient"],
  names: RecipientNames,
  t: Translator,
): string {
  switch (recipient.kind) {
    case "family": {
      const found = names.contacts.get(recipient.contactId);
      return found
        ? t("people.sharing.recipientFamily", {
            name: `${found.givenName} ${found.familyName}`,
            role: t("people.contacts.role", { role: found.role }),
          })
        : t("people.sharing.unknownContact");
    }
    case "professional": {
      const name = names.staff.get(recipient.tenantUserId);
      return name
        ? t("people.sharing.recipientProfessional", { name })
        : t("people.sharing.unknownProfessional");
    }
    case "link":
      return t("people.sharing.recipientLink");
  }
}

/** The authority roles a contact can hold, from their contact role and a deputy's order. */
export function authorityRolesFor(
  contact: Pick<ContactOut, "role" | "authorityScope">,
): readonly NonNullable<CreateSharingDecision["authority"]>["role"][] {
  switch (contact.role) {
    case "lpa_health_welfare":
      return ["lpa_health_welfare"];
    case "lpa_property_finance":
      return ["lpa_property_finance"];
    case "appointee":
      return ["appointee"];
    case "deputy":
      return contact.authorityScope === "personal_welfare"
        ? ["deputy_personal_welfare"]
        : contact.authorityScope === "property_affairs"
          ? ["deputy_property_affairs"]
          : contact.authorityScope === "both"
            ? ["deputy_personal_welfare", "deputy_property_affairs"]
            : [];
    default:
      return [];
  }
}

export const SHARING_FIELDS = [
  "recipientKind",
  "contactId",
  "tenantUserId",
  "sections",
  "basis",
  "consentGivenBy",
  "authorityContactId",
  "authorityRole",
  "orderSections",
  "capacity",
  "capacityAssessmentId",
  "bestInterestsDecisionId",
  "validTo",
] as const;

export type SharingRead =
  | { readonly ok: true; readonly decision: CreateSharingDecision }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const BASES = ["consent", "legal_authority", "best_interests", "direct_care"] as const;
const CAPACITIES = ["presumed", "assessed_has_capacity", "assessed_lacks_capacity"] as const;

/**
 * The sharing decision form as the API takes it, with every problem it can find at once. The
 * decision ends at the end of the day chosen (UK time); that day arrives already read from its
 * boxes. The API checks the basis, the authority and the capacity finding again (rule 13).
 */
export function readSharingForm(
  form: FormValues,
  validToDate: string | null,
  today: string,
  t: Translator,
): SharingRead {
  const errors: Record<string, string> = {};
  const kind = text(form, "recipientKind");
  let recipient: CreateSharingDecision["recipient"] | null = null;
  if (kind === "family") {
    const contactId = text(form, "contactId");
    if (contactId) recipient = { kind: "family", contactId };
    else errors.contactId = t("people.sharing.form.contactRequired");
  } else if (kind === "professional") {
    const tenantUserId = text(form, "tenantUserId");
    if (tenantUserId) recipient = { kind: "professional", tenantUserId };
    else errors.tenantUserId = t("people.sharing.form.professionalRequired");
  } else if (kind === "link") {
    recipient = { kind: "link" };
  } else {
    errors.recipientKind = t("people.sharing.form.recipientRequired");
  }
  const sections = form
    .getAll("sections")
    .map(String)
    .filter((s): s is SharingSection => (SHARING_SECTION_KEYS as readonly string[]).includes(s));
  if (sections.length === 0) errors.sections = t("people.sharing.form.sectionsRequired");
  const basis = text(form, "basis") as (typeof BASES)[number];
  if (!BASES.includes(basis)) errors.basis = t("people.sharing.form.basisRequired");
  const consentGivenBy = text(form, "consentGivenBy");
  if (basis === "consent" && consentGivenBy !== "person" && consentGivenBy !== "authority_holder") {
    errors.consentGivenBy = t("people.sharing.form.consentByRequired");
  }
  const needsAuthority =
    basis === "legal_authority" || (basis === "consent" && consentGivenBy === "authority_holder");
  let authority: CreateSharingDecision["authority"];
  if (needsAuthority) {
    // A legal authority is held by the family member it shares with (rule 13).
    const contactId =
      basis === "legal_authority" && recipient?.kind === "family"
        ? recipient.contactId
        : text(form, "authorityContactId");
    const role = text(form, "authorityRole");
    if (!contactId) errors.authorityContactId = t("people.sharing.form.authorityRequired");
    if (!role) errors.authorityRole = t("people.sharing.form.authorityRoleRequired");
    const orderSections = form
      .getAll("orderSections")
      .map(String)
      .filter((s): s is SharingSection => (SHARING_SECTION_KEYS as readonly string[]).includes(s));
    const deputy = role.startsWith("deputy_");
    if (deputy && orderSections.length === 0) {
      errors.orderSections = t("people.sharing.form.orderSectionsRequired");
    }
    if (contactId && role) {
      authority = {
        role: role as NonNullable<CreateSharingDecision["authority"]>["role"],
        contactId,
        ...(deputy && orderSections.length > 0 ? { orderSections } : {}),
      };
    }
  }
  const capacity = (text(form, "capacity") || "presumed") as (typeof CAPACITIES)[number];
  if (!CAPACITIES.includes(capacity)) errors.capacity = t("people.sharing.form.capacityRequired");
  const capacityAssessmentId = text(form, "capacityAssessmentId");
  if (capacity !== "presumed" && !capacityAssessmentId) {
    errors.capacityAssessmentId = t("people.sharing.form.assessmentRequired");
  }
  const bestInterestsDecisionId = text(form, "bestInterestsDecisionId");
  if (basis === "best_interests" && !bestInterestsDecisionId) {
    errors.bestInterestsDecisionId = t("people.sharing.form.bestInterestsRequired");
  }
  if (!validToDate) {
    errors.validTo = t("people.sharing.form.validToRequired");
  } else if (validToDate < today) {
    errors.validTo = t("people.sharing.form.validToPast");
  }
  if (Object.keys(errors).length > 0 || !recipient || !validToDate) return { ok: false, errors };
  return {
    ok: true,
    decision: {
      recipient,
      sections,
      basis,
      ...(basis === "consent" ? { consentGivenBy: consentGivenBy as "person" } : {}),
      capacity,
      ...(capacity !== "presumed" ? { capacityAssessmentId } : {}),
      ...(basis === "best_interests" ? { bestInterestsDecisionId } : {}),
      ...(authority ? { authority } : {}),
      validTo: ukEndOfDay(validToDate).toISOString(),
    },
  };
}

// ------------------------------------------------------------------------------------------------
// About Me share links
// ------------------------------------------------------------------------------------------------

export type LinkStatus = "active" | "revoked" | "expired" | "closed";

/** A link's state in words: revoked, expired, closed because its decision is not in force, or active. */
export function linkStatus(link: AboutMeShareLinkOut, now: Date): LinkStatus {
  if (link.revokedAt) return "revoked";
  if (Date.parse(link.expiresAt) <= now.getTime()) return "expired";
  return link.active ? "active" : "closed";
}

/** The decisions a new link may rest on: for a share link, covering About Me, in force now. */
export function linkDecisions(items: readonly SharingDecisionOut[]): SharingDecisionOut[] {
  return items.filter(
    (d) => d.recipient.kind === "link" && d.sections.includes("about_me") && d.inForce,
  );
}

/** The last UK day a decision is in force on (it ends at the first moment after that day). */
export function decisionLastDay(validTo: string): string {
  return ukIsoDate(new Date(Date.parse(validTo) - 1));
}

/**
 * When a link chosen to expire at the end of `date` (UK time) stops: that moment, or the moment
 * its decision ends when that is sooner on the same day, since a link never outlives its decision
 * (rule 13). A day before today, or after the decision's last day, is refused.
 */
export function linkExpiry(
  date: string,
  decisionValidTo: string,
  today: string,
):
  | { readonly ok: true; readonly expiresAt: string }
  | { readonly ok: false; readonly problem: "past" | "after_decision" } {
  if (date < today) return { ok: false, problem: "past" };
  if (date > decisionLastDay(decisionValidTo)) return { ok: false, problem: "after_decision" };
  const end = Math.min(ukEndOfDay(date).getTime(), Date.parse(decisionValidTo));
  return { ok: true, expiresAt: new Date(end).toISOString() };
}
