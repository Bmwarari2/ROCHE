import type { ActivityAttendance, ActivityEngagement, VisitKind } from "../care/activities";
import { PCSP_DOMAIN_LABELS, PCSP_DOMAINS, type PcspDomain } from "../care/care-plan";
import { LIVE_PERSON_STATUSES, type PersonStatus } from "../people/lifecycle";
import type { SharingSection } from "../people/sharing";
import {
  FEED_MAX_DIGIT_RUN,
  type FeedClinicalTermMatch,
  type FeedNameMention,
  type FeedPersonName,
  type FeedReadabilityFinding,
  feedReadabilityLint,
  findClinicalTerms,
  findNameMentions,
  hasEmailLikeText,
  longestDigitRun,
} from "./feed-text";
import {
  FEED_ITEM_SECTIONS,
  FEED_WITHDRAWAL_REASONS,
  type FeedItemKind,
  type FeedPhotoBasis,
} from "./feed-visibility";

/**
 * Family feed composition (COMMS-001; comms.md section 4 rules 4 and 6 to 10). Turns point-of-care
 * records into updates a family member can read: activities, visits and appointments, photos and
 * care plan updates in approved phrasing; daily notes only when a member of staff has marked the
 * note as shareable and written it for the family. Nothing clinical is ever composed: observations,
 * charts, assessments, validated tool results, body maps, medicines and incidents have no feed kind
 * at all, and staff-written text is refused when it names a score, a diagnosis or a prognosis
 * (medical-device boundary), another resident, or contact details. Staff surnames are removed
 * when the tenant asks. The reading-age lint is advice for the writer, never a gate.
 */

export const FEED_SOURCE_KINDS = [
  "activity",
  "visit",
  "shared_note",
  "photo",
  "care_plan_update",
  "finance_statement",
] as const;
export type FeedSourceKind = (typeof FEED_SOURCE_KINDS)[number];

interface SourceBase {
  /** The record the update comes from (activity, visit log entry, note, document, plan section). */
  readonly id: string;
  readonly personId: string;
  readonly occurredAt: Date;
}

export type FeedSource =
  | (SourceBase & {
      readonly kind: "activity";
      /** The programme's name for the activity ("Garden club"). */
      readonly activityName: string;
      readonly attendance: ActivityAttendance;
      readonly engagement: ActivityEngagement | null;
    })
  | (SourceBase & {
      readonly kind: "visit";
      readonly visitKind: VisitKind;
      /** Restrictions and their reasons stay in the care record; they never reach the feed. */
      readonly restrictionsApplied: boolean;
    })
  | (SourceBase & {
      readonly kind: "shared_note";
      /** The words written for the family, not the clinical note. */
      readonly text: string;
      /** The member of staff who marked the note as shareable, and when. */
      readonly markedShareableBy: string | null;
      readonly markedShareableAt: Date | null;
    })
  | (SourceBase & {
      readonly kind: "photo";
      readonly documentId: string;
      readonly caption: string | null;
      /** Anyone other than the person can be recognised in the photo. */
      readonly otherPeopleIdentifiable: boolean;
      readonly markedForFeedBy: string | null;
    })
  | (SourceBase & {
      readonly kind: "care_plan_update";
      /** The care plan section's need domain; the update is the published version. */
      readonly domain: string;
    })
  | (SourceBase & {
      /** Placeholder until finance (Phase 3) issues statements: carries no money figures. */
      readonly kind: "finance_statement";
    });

export type StaffNameRule = "full_name" | "first_name_only";

export interface FeedComposeContext {
  readonly person: {
    readonly id: string;
    readonly status: PersonStatus;
    /** The name the family uses in updates, usually the preferred name. */
    readonly name: string;
  } & FeedPersonName;
  /** Other people living at the location, never named in another person's feed. */
  readonly otherResidents: readonly FeedPersonName[];
  /** Staff at the location, whose surnames the tenant may keep out of the feed. */
  readonly staff: readonly FeedPersonName[];
  /** Tenant setting. */
  readonly staffNames: StaffNameRule;
  /** For photos: from `feedPhotoBasis` at the time of composing. */
  readonly photoBasis: FeedPhotoBasis | null;
  readonly now: Date;
}

// ------------------------------------------------------------------------------------------------
// Approved phrasing (master prompt 8: plain English at reading age 9 for family surfaces)
// ------------------------------------------------------------------------------------------------

/**
 * The only sentences Harbour writes into a family feed. They say what happened, never how the
 * person is ("doing well", "settled" and the like are never written: HZ-061), and they carry no
 * clinical content. `{name}` is the person's name, `{activity}` the programme's activity name and
 * `{domain}` the care plan section in lower case. Tests hold every phrase to the reading-age lint
 * and the clinical vocabulary.
 */
export const FEED_PHRASES = {
  "activity.attended.engaged_throughout":
    "{name} joined {activity} and took part all the way through.",
  "activity.attended.engaged_some_of_the_time":
    "{name} joined {activity} and took part some of the time.",
  "activity.attended.engaged_briefly": "{name} joined {activity} for a short while.",
  "activity.attended.did_not_engage": "{name} came along to {activity}.",
  "activity.partly_attended": "{name} joined part of {activity}.",
  "activity.declined": "{name} chose not to join {activity} this time.",
  "visit.facilitated_visit": "{name} had a visitor.",
  "visit.visit_out": "{name} went out on a visit.",
  "appointment.accompaniment": "{name} went to an appointment with a member of staff.",
  "photo.default": "A new photo of {name}.",
  "care_plan_update.published": "{name}'s care plan was updated: {domain}.",
  "finance_statement.ready": "A new statement is ready to view.",
} as const;
export type FeedPhraseKey = keyof typeof FEED_PHRASES;

/** Placeholders a phrase may use. */
export const FEED_PHRASE_PLACEHOLDERS = ["name", "activity", "domain"] as const;

function fill(
  key: FeedPhraseKey,
  values: Partial<Record<(typeof FEED_PHRASE_PLACEHOLDERS)[number], string>>,
): string {
  let text: string = FEED_PHRASES[key];
  for (const placeholder of FEED_PHRASE_PLACEHOLDERS) {
    const value = values[placeholder];
    if (value !== undefined) text = text.split(`{${placeholder}}`).join(value);
  }
  return text;
}

// ------------------------------------------------------------------------------------------------
// Checks on words a member of staff wrote
// ------------------------------------------------------------------------------------------------

/** Longest free text accepted in one update (a structural limit, not a writing target). */
export const FEED_TEXT_MAX_LENGTH = 1000;

export type FeedTextProblem =
  | { readonly problem: "text_required"; readonly message: string }
  | { readonly problem: "text_too_long"; readonly message: string }
  | {
      readonly problem: "clinical_term";
      readonly terms: readonly FeedClinicalTermMatch[];
      readonly message: string;
    }
  | {
      readonly problem: "names_another_resident";
      readonly found: readonly string[];
      readonly message: string;
    }
  | {
      readonly problem: "names_staff_surname";
      readonly found: readonly string[];
      readonly message: string;
    }
  | { readonly problem: "contact_details"; readonly message: string }
  | { readonly problem: "long_number"; readonly message: string };

function residentNameForms(person: FeedPersonName, subject: FeedPersonName): string[] {
  // Full name and surname always; the first name alone only when it is not also the subject's.
  const forms = [`${person.givenName} ${person.familyName}`, person.familyName];
  if (person.givenName !== subject.givenName && person.givenName !== subject.familyName) {
    forms.push(person.givenName);
  }
  return forms.filter((f) => f.trim().length > 0);
}

/** Mentions not inside a longer one, in text order ("Dev Sample", not also "Dev" and "Sample"). */
function outermost(mentions: readonly FeedNameMention[]): FeedNameMention[] {
  return mentions
    .filter(
      (m) =>
        !mentions.some(
          (other) =>
            other !== m &&
            other.start <= m.start &&
            other.end >= m.end &&
            other.end - other.start > m.end - m.start,
        ),
    )
    .sort((a, b) => a.start - b.start);
}

/** Replaces each staff member's full name with their first name (keeping a possessive ending). */
export function stripStaffSurnames(text: string, staff: readonly FeedPersonName[]): string {
  let result = text;
  for (const member of staff) {
    const mentions = findNameMentions(result, `${member.givenName} ${member.familyName}`);
    for (const mention of [...mentions].reverse()) {
      result = `${result.slice(0, mention.start)}${member.givenName.trim()}${mention.possessive}${result.slice(mention.end)}`;
    }
  }
  return result;
}

export interface FeedTextCheck {
  /** The text after staff surnames were removed (when the tenant asks). */
  readonly text: string;
  readonly problems: readonly FeedTextProblem[];
  readonly lint: readonly FeedReadabilityFinding[];
}

/**
 * Checks words a member of staff wrote for the family (a shared note, a photo caption, an activity
 * name). Problems refuse the update so the writer can change it; the lint is advice.
 */
export function checkFeedText(
  raw: string,
  context: Pick<FeedComposeContext, "person" | "otherResidents" | "staff" | "staffNames">,
): FeedTextCheck {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      text: trimmed,
      problems: [{ problem: "text_required", message: "Write the update for the family." }],
      lint: [],
    };
  }
  if (trimmed.length > FEED_TEXT_MAX_LENGTH) {
    return {
      text: trimmed,
      problems: [
        {
          problem: "text_too_long",
          message: `Keep the update under ${FEED_TEXT_MAX_LENGTH} characters.`,
        },
      ],
      lint: [],
    };
  }
  const text =
    context.staffNames === "first_name_only" ? stripStaffSurnames(trimmed, context.staff) : trimmed;
  const problems: FeedTextProblem[] = [];

  const terms = findClinicalTerms(text);
  if (terms.length > 0) {
    problems.push({
      problem: "clinical_term",
      terms,
      message: `Family updates do not carry scores, diagnoses, health measurements or medicines. Say it another way, or leave out: ${[...new Set(terms.map((t) => t.found))].join(", ")}.`,
    });
  }

  const residents = new Set(
    outermost(
      context.otherResidents.flatMap((resident) =>
        residentNameForms(resident, context.person).flatMap((form) => findNameMentions(text, form)),
      ),
    ).map((m) => m.found),
  );
  if (residents.size > 0) {
    problems.push({
      problem: "names_another_resident",
      found: [...residents],
      message: 'Do not name other residents. Write "another resident" or "friends" instead.',
    });
  }

  if (context.staffNames === "first_name_only") {
    const surnames = new Set<string>();
    for (const member of context.staff) {
      for (const mention of findNameMentions(text, member.familyName)) surnames.add(mention.found);
    }
    if (surnames.size > 0) {
      problems.push({
        problem: "names_staff_surname",
        found: [...surnames],
        message: "This home uses staff first names only in family updates. Remove the surname.",
      });
    }
  }

  if (hasEmailLikeText(text)) {
    problems.push({
      problem: "contact_details",
      message: "Do not put email addresses in family updates.",
    });
  }
  if (longestDigitRun(text) > FEED_MAX_DIGIT_RUN) {
    problems.push({
      problem: "long_number",
      message: "Do not put phone numbers, NHS numbers or other long numbers in family updates.",
    });
  }
  return { text, problems, lint: feedReadabilityLint(text) };
}

// ------------------------------------------------------------------------------------------------
// Composition
// ------------------------------------------------------------------------------------------------

export interface ComposedFeedItem {
  readonly personId: string;
  readonly kind: FeedItemKind;
  readonly section: SharingSection;
  readonly carePlanDomain: string | null;
  readonly sourceKind: FeedSourceKind;
  readonly sourceId: string;
  readonly occurredAt: Date;
  readonly composedAt: Date;
  readonly text: string;
  readonly photoDocumentId: string | null;
  /** The approved phrase used, or null when the words are a member of staff's. */
  readonly phraseKey: FeedPhraseKey | null;
}

export type FeedComposeProblem =
  | FeedTextProblem
  | { readonly problem: "wrong_person"; readonly message: string }
  | { readonly problem: "person_record_closed"; readonly message: string }
  | { readonly problem: "in_future"; readonly message: string }
  | { readonly problem: "not_for_the_feed"; readonly message: string }
  | { readonly problem: "note_not_marked_shareable"; readonly message: string }
  | { readonly problem: "photo_not_marked_for_feed"; readonly message: string }
  | { readonly problem: "photo_basis_missing"; readonly message: string }
  | { readonly problem: "photo_shows_other_people"; readonly message: string }
  | { readonly problem: "unknown_care_plan_domain"; readonly message: string };

export type FeedComposeResult =
  | {
      readonly ok: true;
      readonly item: ComposedFeedItem;
      readonly lint: readonly FeedReadabilityFinding[];
    }
  | { readonly ok: false; readonly problems: readonly FeedComposeProblem[] };

function isPcspDomain(value: string): value is PcspDomain {
  return (PCSP_DOMAINS as readonly string[]).includes(value);
}

function activityPhrase(source: Extract<FeedSource, { kind: "activity" }>): FeedPhraseKey | null {
  switch (source.attendance) {
    case "attended":
      return `activity.attended.${source.engagement ?? "did_not_engage"}` as FeedPhraseKey;
    case "partly_attended":
      return "activity.partly_attended";
    case "declined":
      return "activity.declined";
    default:
      // "Not able to join" is never shared: the reason may be about the person's health.
      return null;
  }
}

/**
 * Composes one family update from one record, or says why it cannot. Composition does not decide
 * who sees the update: `checkFeedItemVisibility` does that for each family member.
 */
export function composeFeedItem(
  source: FeedSource,
  context: FeedComposeContext,
): FeedComposeResult {
  const refuse = (problems: FeedComposeProblem[]): FeedComposeResult => ({ ok: false, problems });
  if (source.personId !== context.person.id) {
    return refuse([{ problem: "wrong_person", message: "This record belongs to someone else." }]);
  }
  if (!LIVE_PERSON_STATUSES.includes(context.person.status)) {
    return refuse([
      {
        problem: "person_record_closed",
        message: "The family feed closes when a person leaves the service or dies.",
      },
    ]);
  }
  if (source.occurredAt.getTime() > context.now.getTime()) {
    return refuse([{ problem: "in_future", message: "This record is dated in the future." }]);
  }
  const name = context.person.name.trim();
  const base = {
    personId: source.personId,
    sourceKind: source.kind,
    sourceId: source.id,
    occurredAt: source.occurredAt,
    composedAt: context.now,
    carePlanDomain: null,
    photoDocumentId: null,
  };
  const phrased = (kind: FeedItemKind, phraseKey: FeedPhraseKey, text: string) => ({
    ok: true as const,
    item: { ...base, kind, section: FEED_ITEM_SECTIONS[kind], text, phraseKey },
    lint: [],
  });

  switch (source.kind) {
    case "activity": {
      const key = activityPhrase(source);
      if (key === null) {
        return refuse([
          {
            problem: "not_for_the_feed",
            message:
              '"Not able to join" is not shared with families, because the reason may be about health.',
          },
        ]);
      }
      const check = checkFeedText(source.activityName, context);
      if (check.problems.length > 0) return refuse([...check.problems]);
      return phrased("activity", key, fill(key, { name, activity: check.text }));
    }
    case "visit": {
      if (source.visitKind === "accompaniment") {
        const key = "appointment.accompaniment";
        return phrased("appointment", key, fill(key, { name }));
      }
      const key = source.visitKind === "visit_out" ? "visit.visit_out" : "visit.facilitated_visit";
      return phrased("visit", key, fill(key, { name }));
    }
    case "shared_note": {
      if (!source.markedShareableBy || !source.markedShareableAt) {
        return refuse([
          {
            problem: "note_not_marked_shareable",
            message: "Only notes a member of staff has marked as shareable go to the family.",
          },
        ]);
      }
      const check = checkFeedText(source.text, context);
      if (check.problems.length > 0) return refuse([...check.problems]);
      return {
        ok: true,
        item: {
          ...base,
          kind: "shared_note",
          section: FEED_ITEM_SECTIONS.shared_note,
          text: check.text,
          phraseKey: null,
        },
        lint: check.lint,
      };
    }
    case "photo": {
      const problems: FeedComposeProblem[] = [];
      if (!source.markedForFeedBy) {
        problems.push({
          problem: "photo_not_marked_for_feed",
          message: "A member of staff chooses each photo for the family feed.",
        });
      }
      if (!context.photoBasis?.ok) {
        problems.push({
          problem: "photo_basis_missing",
          message:
            context.photoBasis && !context.photoBasis.ok
              ? context.photoBasis.message
              : "Check the person's consent to photos first.",
        });
      }
      if (source.otherPeopleIdentifiable) {
        problems.push({
          problem: "photo_shows_other_people",
          message: "Choose a photo where only this person can be recognised, or crop it.",
        });
      }
      const caption = source.caption?.trim() ?? "";
      const check = caption.length > 0 ? checkFeedText(caption, context) : null;
      if (check) problems.push(...check.problems);
      if (problems.length > 0) return refuse(problems);
      const key = "photo.default";
      return {
        ok: true,
        item: {
          ...base,
          kind: "photo",
          section: FEED_ITEM_SECTIONS.photo,
          text: check ? check.text : fill(key, { name }),
          photoDocumentId: source.documentId,
          phraseKey: check ? null : key,
        },
        lint: check ? check.lint : [],
      };
    }
    case "care_plan_update": {
      if (!isPcspDomain(source.domain)) {
        return refuse([
          {
            problem: "unknown_care_plan_domain",
            message: "This care plan section is not recognised.",
          },
        ]);
      }
      const key = "care_plan_update.published";
      const text = fill(key, { name, domain: PCSP_DOMAIN_LABELS[source.domain].toLowerCase() });
      return {
        ok: true,
        item: {
          ...base,
          kind: "care_plan_update",
          section: FEED_ITEM_SECTIONS.care_plan_update,
          carePlanDomain: source.domain,
          text,
          phraseKey: key,
        },
        lint: [],
      };
    }
    case "finance_statement": {
      const key = "finance_statement.ready";
      return phrased("finance_statement", key, fill(key, {}));
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Withdrawal and correction (HZ-061)
// ------------------------------------------------------------------------------------------------

export interface FeedWithdrawal {
  readonly reason: string;
  readonly by: string | null;
  readonly at: Date;
}

export type FeedWithdrawalProblem =
  | "already_withdrawn"
  | "unknown_reason"
  | "who_required"
  | "before_composed"
  | "in_future";

/**
 * Checks taking an update down. When a source record is corrected (a note superseded), its update
 * is withdrawn with `source_corrected` and a corrected update, if one is still right to share, is
 * composed from the new record naming the one it replaces (`supersedesItemId`). Withdrawal is a
 * dated mark, never a delete: the update stays in the history with who saw it, and a family member
 * who saw it is told it was taken down (`FEED_WITHDRAWN_NOTICE`, HZ-061).
 */
export function checkFeedWithdrawal(
  item: { readonly composedAt: Date; readonly withdrawnAt: Date | null },
  withdrawal: FeedWithdrawal,
  now: Date,
): FeedWithdrawalProblem[] {
  const problems: FeedWithdrawalProblem[] = [];
  if (item.withdrawnAt !== null) problems.push("already_withdrawn");
  if (!(FEED_WITHDRAWAL_REASONS as readonly string[]).includes(withdrawal.reason)) {
    problems.push("unknown_reason");
  }
  if (!withdrawal.by) problems.push("who_required");
  if (withdrawal.at.getTime() < item.composedAt.getTime()) problems.push("before_composed");
  if (withdrawal.at.getTime() > now.getTime()) problems.push("in_future");
  return problems;
}

/** Photo updates to take down when the photo basis no longer holds (consent withdrawn, refused). */
export function photoItemsToWithdraw(
  items: readonly {
    readonly id: string;
    readonly kind: FeedItemKind;
    readonly withdrawnAt: Date | null;
  }[],
  basis: FeedPhotoBasis,
): string[] {
  if (basis.ok) return [];
  return items.filter((i) => i.kind === "photo" && i.withdrawnAt === null).map((i) => i.id);
}
