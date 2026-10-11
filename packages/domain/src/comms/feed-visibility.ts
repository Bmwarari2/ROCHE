import type { CapacityAssessmentView } from "../care/mca/capacity";
import { capacityFinding } from "../care/mca/capacity";
import { type ConsentRecordView, consentStatus } from "../care/mca/consent";
import type { PersonStatus } from "../people/lifecycle";
import {
  checkSectionVisibility,
  type HiddenReason,
  type SharingDecision,
  type SharingSection,
} from "../people/sharing";
import { formatUkDateTime } from "../shared/time";
import { ukIsoDate } from "../shared/working-days";

/**
 * Family feed visibility (COMMS-001; comms.md section 4 rules 1 to 6 and 12; master prompt 15.1
 * "sections stay closed until that record exists"; hazard HZ-022).
 *
 * The feed adds nothing to the sharing rules: each item belongs to one section of the person's
 * record, and `checkSectionVisibility` (people/sharing.ts) decides whether that section is open to
 * that family member now. That rule already closes the feed when there is no decision, when it has
 * expired, been withdrawn or suspended, when an attorney's or deputy's authority does not cover the
 * section or has lapsed, and when the person is not receiving care (people.md rule 13, from the
 * statuses in people/lifecycle.ts). On top of it the feed adds: an item from before the decision
 * started stays closed; a withdrawn item is never shown again; a photo also needs its own lawful
 * basis (consent, or a best-interests decision for a person who lacks capacity to decide).
 */

export const FEED_ITEM_KINDS = [
  "activity",
  "visit",
  "appointment",
  "shared_note",
  "photo",
  "care_plan_update",
  "finance_statement",
] as const;
export type FeedItemKind = (typeof FEED_ITEM_KINDS)[number];

/**
 * The section of the record each kind of item belongs to. Finance statements are a typed
 * placeholder until the finance module (Phase 3) produces them: only a decision covering `finance`
 * opens them, which a property and financial affairs attorney or deputy may hold (sharing.ts).
 */
export const FEED_ITEM_SECTIONS: Readonly<Record<FeedItemKind, SharingSection>> = {
  activity: "activities_and_visits",
  visit: "activities_and_visits",
  appointment: "appointments",
  shared_note: "daily_updates",
  photo: "photos",
  care_plan_update: "care_plan",
  finance_statement: "finance",
};

export const FEED_WITHDRAWAL_REASONS = [
  "source_corrected",
  "published_in_error",
  "person_asked",
  "photo_consent_withdrawn",
] as const;
export type FeedWithdrawalReason = (typeof FEED_WITHDRAWAL_REASONS)[number];

/** A published family update as stored (append-only; withdrawal is a dated mark, not a delete). */
export interface FeedItem {
  readonly id: string;
  readonly personId: string;
  readonly kind: FeedItemKind;
  /** For a care plan update: the PCSP domain, which a decision may limit (sharing.ts). */
  readonly carePlanDomain: string | null;
  /** When the thing happened. */
  readonly occurredAt: Date;
  /** When it was written for the family. */
  readonly composedAt: Date;
  readonly text: string;
  readonly photoDocumentId: string | null;
  /** The item this one corrects, if any. */
  readonly supersedesItemId: string | null;
  readonly withdrawnAt: Date | null;
  readonly withdrawnReason: FeedWithdrawalReason | null;
}

// ------------------------------------------------------------------------------------------------
// Photos: their own lawful basis (master prompt 5.1: consent covers only optional processing)
// ------------------------------------------------------------------------------------------------

/** A recorded best-interests decision about sharing photos, as the feed reads it. */
export interface PhotoBestInterestsView {
  readonly id: string;
  /** The capacity assessment of the `photos` decision that it follows. */
  readonly capacityAssessmentId: string;
  readonly decidedAt: Date;
  /** The decision reached: photos may be shared with the family, or not. */
  readonly sharePhotos: boolean;
  /** yyyy-mm-dd. */
  readonly reviewOn: string | null;
}

export type FeedPhotoBasis =
  | { readonly ok: true; readonly basis: "consent"; readonly consentRecordId: string }
  | {
      readonly ok: true;
      readonly basis: "best_interests";
      readonly bestInterestsDecisionId: string;
      readonly capacityAssessmentId: string;
    }
  | {
      readonly ok: false;
      readonly problem:
        | "consent_needed"
        | "consent_refused"
        | "consent_not_valid"
        | "capacity_review_overdue"
        | "best_interests_needed"
        | "best_interests_against_sharing"
        | "best_interests_review_overdue";
      readonly message: string;
    };

export interface FeedPhotoBasisInput {
  readonly consents: readonly ConsentRecordView[];
  readonly capacityAssessments: readonly CapacityAssessmentView[];
  readonly bestInterestsDecisions: readonly PhotoBestInterestsView[];
  readonly at: Date;
}

/**
 * Whether photos of the person may be shared in the family feed at a time. Consent is the lawful
 * basis for this optional processing (records of processing B8): the person's own consent, or that
 * of a representative whose authority covers it (care/mca/consent.ts). Where an assessment shows
 * the person lacks capacity to decide about photos, a recorded best-interests decision in favour,
 * following that assessment, is the alternative. A refusal stops photos whatever else is recorded.
 */
export function feedPhotoBasis(input: FeedPhotoBasisInput): FeedPhotoBasis {
  const today = ukIsoDate(input.at);
  const capacity = capacityFinding(input.capacityAssessments, "photos", input.at, today);
  const consent = consentStatus(input.consents, "photos", input.at, capacity.status);
  if (consent.status === "valid") {
    return { ok: true, basis: "consent", consentRecordId: consent.record.id };
  }
  if (consent.status === "refused") {
    return {
      ok: false,
      problem: "consent_refused",
      message: `${consent.message} Photos are not shared with the family.`,
    };
  }
  if (capacity.status !== "lacks_capacity") {
    return consent.record === null
      ? {
          ok: false,
          problem: "consent_needed",
          message: "Ask the person whether photos can be shared with their family, and record it.",
        }
      : { ok: false, problem: "consent_not_valid", message: consent.message };
  }
  if (capacity.reviewOverdue) {
    return {
      ok: false,
      problem: "capacity_review_overdue",
      message: "The capacity assessment about photos is due for review. Review it first.",
    };
  }
  const decision = input.bestInterestsDecisions
    .filter(
      (d) =>
        d.capacityAssessmentId === capacity.assessment.id &&
        d.decidedAt.getTime() <= input.at.getTime(),
    )
    .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime())[0];
  if (!decision) {
    return {
      ok: false,
      problem: "best_interests_needed",
      message:
        "The person lacks capacity to decide about photos. Record a best-interests decision, or the consent of an attorney or deputy whose authority covers it.",
    };
  }
  if (!decision.sharePhotos) {
    return {
      ok: false,
      problem: "best_interests_against_sharing",
      message: "The best-interests decision was not to share photos with the family.",
    };
  }
  if (decision.reviewOn !== null && decision.reviewOn < today) {
    return {
      ok: false,
      problem: "best_interests_review_overdue",
      message: "The best-interests decision about photos is due for review. Review it first.",
    };
  }
  return {
    ok: true,
    basis: "best_interests",
    bestInterestsDecisionId: decision.id,
    capacityAssessmentId: capacity.assessment.id,
  };
}

// ------------------------------------------------------------------------------------------------
// Visibility of one item
// ------------------------------------------------------------------------------------------------

export type FeedHiddenReason =
  | HiddenReason
  | "wrong_person"
  | "before_decision_start"
  | "item_withdrawn"
  | "photo_basis_missing";

export type FeedItemVisibility =
  | {
      readonly visible: true;
      /** `withdrawn_notice`: only that an update this viewer saw was withdrawn, never its content. */
      readonly display: "item" | "withdrawn_notice";
      readonly section: SharingSection;
      readonly decisionId: string;
      readonly expiresAt: Date;
    }
  | { readonly visible: false; readonly reason: FeedHiddenReason };

export interface FeedViewerContext {
  readonly person: { readonly id: string; readonly status: PersonStatus };
  /** The family member or representative, as the contact the decisions name. */
  readonly contactId: string;
  readonly decisions: readonly SharingDecision[];
  /** Needed for photos; see `feedPhotoBasis`. */
  readonly photoBasis: FeedPhotoBasis | null;
  readonly now: Date;
}

/**
 * Whether one feed item may be shown to one family member now (HZ-022). Closed by default: with no
 * decision, or none in force for the item's section, it is hidden. `seenBefore` says whether this
 * viewer saw the item before it was withdrawn (from the view log).
 */
export function checkFeedItemVisibility(
  item: FeedItem,
  context: FeedViewerContext,
  seenBefore = false,
): FeedItemVisibility {
  if (item.personId !== context.person.id) return { visible: false, reason: "wrong_person" };
  const section = FEED_ITEM_SECTIONS[item.kind];
  const request = {
    personId: context.person.id,
    personStatus: context.person.status,
    recipient: { kind: "family", contactId: context.contactId } as const,
    section,
    carePlanDomain: item.carePlanDomain,
    now: context.now,
  };
  // Only decisions that had started by the time the thing happened can share it.
  const covering = context.decisions.filter(
    (d) => d.validFrom.getTime() <= item.occurredAt.getTime(),
  );
  const result = checkSectionVisibility(covering, request);
  if (!result.visible) {
    if (
      covering.length < context.decisions.length &&
      checkSectionVisibility(context.decisions, request).visible
    ) {
      return { visible: false, reason: "before_decision_start" };
    }
    return { visible: false, reason: result.reason };
  }
  const shown = { section, decisionId: result.decisionId, expiresAt: result.expiresAt };
  if (item.withdrawnAt !== null && item.withdrawnAt.getTime() <= context.now.getTime()) {
    return seenBefore
      ? { visible: true, display: "withdrawn_notice", ...shown }
      : { visible: false, reason: "item_withdrawn" };
  }
  if (item.kind === "photo" && !context.photoBasis?.ok) {
    return { visible: false, reason: "photo_basis_missing" };
  }
  return { visible: true, display: "item", ...shown };
}

// ------------------------------------------------------------------------------------------------
// The feed a family member sees (HZ-022, HZ-061)
// ------------------------------------------------------------------------------------------------

/** Shown at the top of every family feed (HZ-061): the feed is not the record and not an alert. */
export const FEED_NOT_FULL_RECORD_STATEMENT =
  "These are everyday updates. They are not the full care record. The home will phone you about anything important.";

/** Shown in place of an update this viewer saw before it was withdrawn (HZ-061). */
export const FEED_WITHDRAWN_NOTICE = "This update was taken down because it was not right.";

export interface FeedEntry {
  readonly itemId: string;
  readonly kind: FeedItemKind;
  readonly display: "item" | "withdrawn_notice";
  /** The update, or the withdrawn notice. */
  readonly text: string;
  readonly photoDocumentId: string | null;
  /** "11/10/2026 14:00": when it happened, always shown. */
  readonly happened: string;
  /** When it was written, shown only when that was on a later day than it happened. */
  readonly addedLater: string | null;
  readonly corrects: string | null;
  /** For the audit of the view (HZ-022): the decision that allowed it. */
  readonly decisionId: string;
}

export interface FamilyFeed {
  readonly statement: string;
  /** When the newest update shown happened, or null when there is none. */
  readonly lastUpdateAt: Date | null;
  readonly entries: readonly FeedEntry[];
}

/**
 * The family feed, newest first. Hidden items are left out without trace; each entry names the
 * decision that allowed it so the API can audit the view.
 */
export function buildFamilyFeed(
  items: readonly FeedItem[],
  context: FeedViewerContext,
  seenItemIds: ReadonlySet<string> = new Set(),
): FamilyFeed {
  const entries: { entry: FeedEntry; item: FeedItem }[] = [];
  for (const item of items) {
    const visibility = checkFeedItemVisibility(item, context, seenItemIds.has(item.id));
    if (!visibility.visible) continue;
    const notice = visibility.display === "withdrawn_notice";
    entries.push({
      item,
      entry: {
        itemId: item.id,
        kind: item.kind,
        display: visibility.display,
        text: notice ? FEED_WITHDRAWN_NOTICE : item.text,
        photoDocumentId: notice ? null : item.photoDocumentId,
        happened: formatUkDateTime(item.occurredAt),
        addedLater:
          ukIsoDate(item.composedAt) > ukIsoDate(item.occurredAt)
            ? formatUkDateTime(item.composedAt)
            : null,
        corrects: notice ? null : item.supersedesItemId,
        decisionId: visibility.decisionId,
      },
    });
  }
  entries.sort(
    (a, b) =>
      b.item.occurredAt.getTime() - a.item.occurredAt.getTime() ||
      b.item.composedAt.getTime() - a.item.composedAt.getTime() ||
      (a.item.id < b.item.id ? -1 : 1),
  );
  const newest = entries.find((e) => e.entry.display === "item");
  return {
    statement: FEED_NOT_FULL_RECORD_STATEMENT,
    lastUpdateAt: newest ? newest.item.occurredAt : null,
    entries: entries.map((e) => e.entry),
  };
}

// ------------------------------------------------------------------------------------------------
// Exposure: what was seen cannot be unseen (comms.md rule 4)
// ------------------------------------------------------------------------------------------------

/** One audited view of one item by one family member (the `comms.feed.viewed` audit event). */
export interface FeedViewRecord {
  readonly itemId: string;
  readonly personId: string;
  readonly contactId: string;
  readonly decisionId: string;
  readonly section: SharingSection;
  readonly carePlanDomain: string | null;
  /** The person's status when the view happened. */
  readonly personStatus: PersonStatus;
  readonly viewedAt: Date;
}

export interface FeedExposure {
  /** Items the family member saw under the decision, with the first time each was seen. */
  readonly seen: readonly { readonly itemId: string; readonly firstSeenAt: Date }[];
  /**
   * Views recorded when the decision was no longer in force (withdrawn, suspended, expired, lapsed,
   * or the person no longer receiving care). There should be none; any is a candidate for the
   * breach register.
   */
  readonly seenAfterClosing: readonly FeedViewRecord[];
}

/**
 * What a family member has seen under one decision, for the withdrawal screen, a DSAR and the
 * breach register. Withdrawing a decision hides items from then on; it cannot undo a view, so the
 * history keeps every one.
 */
export function feedExposure(
  decision: SharingDecision,
  views: readonly FeedViewRecord[],
): FeedExposure {
  const mine = views
    .filter((v) => v.decisionId === decision.id)
    .sort((a, b) => a.viewedAt.getTime() - b.viewedAt.getTime());
  const firstSeen = new Map<string, Date>();
  const after: FeedViewRecord[] = [];
  for (const view of mine) {
    const inForce = checkSectionVisibility([decision], {
      personId: view.personId,
      personStatus: view.personStatus,
      recipient: { kind: "family", contactId: view.contactId },
      section: view.section,
      carePlanDomain: view.carePlanDomain,
      now: view.viewedAt,
    });
    if (!inForce.visible) {
      after.push(view);
      continue;
    }
    if (!firstSeen.has(view.itemId)) firstSeen.set(view.itemId, view.viewedAt);
  }
  return {
    seen: [...firstSeen].map(([itemId, firstSeenAt]) => ({ itemId, firstSeenAt })),
    seenAfterClosing: after,
  };
}
