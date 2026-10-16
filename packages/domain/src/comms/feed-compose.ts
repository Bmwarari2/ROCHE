import type { ActivityAttendance, ActivityEngagement, VisitKind } from "../care/activities";
import { PCSP_DOMAIN_LABELS, PCSP_DOMAINS, type PcspDomain } from "../care/care-plan";
import { LIVE_PERSON_STATUSES, type PersonStatus } from "../people/lifecycle";
import type { SharingSection } from "../people/sharing";
import { CANDOUR_WORKFLOW, type CandourState } from "../safety/candour";
import type { IncidentState } from "../safety/incident";
import {
  FEED_MAX_DIGIT_RUN,
  type FeedClinicalTermMatch,
  type FeedNameMention,
  type FeedPersonName,
  type FeedReadabilityFinding,
  type FeedTermMatch,
  feedReadabilityLint,
  findClinicalTerms,
  findConfirmationTerms,
  findNameMentions,
  foldLookalikes,
  hasEmailLikeText,
  longestDigitRun,
  normaliseFeedText,
} from "./feed-text";
import {
  carePlanDomainMayAppear,
  FEED_ITEM_SECTIONS,
  FEED_WITHDRAWAL_REASONS,
  type FeedItemKind,
  type FeedPhotoBasis,
} from "./feed-visibility";

/**
 * Family feed composition (COMMS-001; comms.md section 4 rules 4 and 6 to 12). Turns point-of-care
 * records into updates a family member can read: activities, finished visits and planned
 * appointments, photos and some care plan updates in approved phrasing; daily notes only when a
 * member of staff has marked the note as shareable and written it for the family. Nothing clinical
 * is ever composed: observations, charts, assessments, validated tool results, body maps,
 * medicines and incidents have no feed kind at all. Staff-written text is refused when it names a
 * score, a diagnosis or a prognosis (medical-device boundary), another resident, or contact
 * details; when it announces an event (a fall, a hospital visit, a death) or claims how the person
 * is, it needs a manager's confirmation with a reason (HZ-060, HZ-061). Publishing is held while
 * the person is in hospital, an incident waits for the next of kin to be told, or a duty of candour
 * step is open. Staff surnames are removed when the tenant asks. The reading-age lint is advice.
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

/** Why a member of staff went with the person (recorded on the visit log for an accompaniment). */
export const ACCOMPANIMENT_PURPOSES = [
  "planned_appointment",
  "unplanned_appointment",
  "emergency",
] as const;
export type AccompanimentPurpose = (typeof ACCOMPANIMENT_PURPOSES)[number];

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
      /** Null while the visit is still going on: it is not composed until it ends. */
      readonly endedAt: Date | null;
      /** Required for an accompaniment: only planned appointments are composed. */
      readonly accompanimentPurpose: AccompanimentPurpose | null;
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

/** An incident about the person, as the publishing hold reads it. */
export interface FeedIncidentView {
  readonly id: string;
  readonly state: IncidentState;
  /** Whether the person's next of kin still have to be told about it. */
  readonly nextOfKinContact: "pending" | "done" | "not_required";
}

/** A manager's confirmation that words flagged as an event or a wellbeing claim may be published. */
export interface FeedPublishConfirmation {
  /** The member of staff confirming. */
  readonly by: string;
  /** Their permissions now; `comms.feed.publish` is required. */
  readonly permissions: ReadonlySet<string>;
  /** Why it may be published, for example "Ben was told by phone at 10:15". */
  readonly reason: string;
}

/** Shortest confirmation reason accepted: a few words, never a tick. */
export const FEED_CONFIRMATION_MIN_REASON_LENGTH = 10;

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
  /** Incidents about the person that are not closed. */
  readonly openIncidents: readonly FeedIncidentView[];
  /** The states of the person's duty of candour records. */
  readonly candourStates: readonly CandourState[];
  /** Given only when a manager confirms flagged words; null otherwise. */
  readonly confirmation: FeedPublishConfirmation | null;
  readonly now: Date;
}

// ------------------------------------------------------------------------------------------------
// Publishing holds (HZ-060, HZ-061)
// ------------------------------------------------------------------------------------------------

export type FeedPublishingHold =
  | "in_hospital"
  | "incident_awaiting_next_of_kin"
  | "candour_step_pending";

/**
 * Why nothing may be published for the person now: while they are in hospital, while an incident
 * waits for their next of kin to be told, and while a duty of candour step is open. The family
 * hears these things from a person first; routine updates would read as "all is well".
 */
export function feedPublishingHolds(input: {
  readonly personStatus: PersonStatus;
  readonly openIncidents: readonly FeedIncidentView[];
  readonly candourStates: readonly CandourState[];
}): FeedPublishingHold[] {
  const holds: FeedPublishingHold[] = [];
  if (input.personStatus === "in_hospital") holds.push("in_hospital");
  if (input.openIncidents.some((i) => i.state !== "closed" && i.nextOfKinContact === "pending")) {
    holds.push("incident_awaiting_next_of_kin");
  }
  if (input.candourStates.some((s) => !CANDOUR_WORKFLOW.terminal.includes(s))) {
    holds.push("candour_step_pending");
  }
  return holds;
}

// ------------------------------------------------------------------------------------------------
// Approved phrasing (master prompt 8: plain English at reading age 9 for family surfaces)
// ------------------------------------------------------------------------------------------------

/**
 * The only sentences Harbour writes into a family feed. They say what happened, never how the
 * person is ("doing well", "settled" and the like are never written: HZ-061), and they carry no
 * clinical content. `{name}` is the person's name, `{activity}` the programme's activity name and
 * `{domain}` the care plan section in lower case. Tests hold every phrase to the reading-age lint,
 * the clinical vocabulary and the event and wellbeing words.
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

/**
 * How old a note or activity may be to become an update (a product rule, not a statutory
 * figure): the feed is about what happened recently, and an old record published now would read
 * as news (HZ-061). The API refuses older ones; the web offers only these.
 */
export const FEED_SOURCE_MAX_AGE_DAYS = 14;

export type FeedTextProblem =
  | { readonly problem: "text_required"; readonly message: string }
  | { readonly problem: "text_too_long"; readonly message: string }
  | {
      readonly problem: "clinical_term";
      readonly terms: readonly FeedClinicalTermMatch[];
      readonly message: string;
    }
  | {
      readonly problem: "needs_confirmation";
      readonly terms: readonly FeedTermMatch<"event" | "wellbeing_claim">[];
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

/** The first names a person goes by: given, preferred and known-as names. */
function firstNames(person: FeedPersonName): string[] {
  return [person.givenName, person.preferredName ?? "", ...(person.knownAs ?? [])]
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

const comparable = (name: string) => foldLookalikes(normaliseFeedText(name)).trim().toLowerCase();

/**
 * How another resident may be named: full names and the surname, matched without regard to case;
 * first names alone matched with their capital, and not when the subject shares that name.
 */
function residentNameForms(
  resident: FeedPersonName,
  subject: FeedPersonName,
): { readonly anyCase: string[]; readonly capitalised: string[] } {
  const family = resident.familyName.trim();
  const subjectNames = new Set([...firstNames(subject), subject.familyName].map(comparable));
  const firsts = firstNames(resident);
  return {
    anyCase: [...firsts.map((first) => `${first} ${family}`), family].filter((f) => f.length > 0),
    capitalised: firsts.filter((first) => !subjectNames.has(comparable(first))),
  };
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

/**
 * Replaces each staff member's full name (any first name they go by, any case) with that first
 * name, keeping a possessive ending. The text must already be normalised.
 */
export function stripStaffSurnames(text: string, staff: readonly FeedPersonName[]): string {
  let result = text;
  for (const member of staff) {
    for (const first of firstNames(member)) {
      const mentions = findNameMentions(result, `${first} ${member.familyName}`, {
        ignoreCase: true,
      });
      for (const mention of [...mentions].reverse()) {
        result = `${result.slice(0, mention.start)}${first}${mention.possessive}${result.slice(mention.end)}`;
      }
    }
  }
  return result;
}

function confirmationValid(confirmation: FeedPublishConfirmation | null): boolean {
  return (
    confirmation !== null &&
    confirmation.by.trim().length > 0 &&
    confirmation.permissions.has("comms.feed.publish") &&
    confirmation.reason.trim().length >= FEED_CONFIRMATION_MIN_REASON_LENGTH
  );
}

export interface FeedTextCheck {
  /** The text normalised (NFKC, no invisible characters) and with staff surnames removed. */
  readonly text: string;
  readonly problems: readonly FeedTextProblem[];
  readonly lint: readonly FeedReadabilityFinding[];
  /** True when flagged words were published on a manager's confirmation. */
  readonly confirmed: boolean;
}

/**
 * Checks words a member of staff wrote for the family (a shared note, a photo caption, an activity
 * name). Problems refuse the update so the writer can change it; the lint is advice.
 */
export function checkFeedText(
  raw: string,
  context: Pick<
    FeedComposeContext,
    "person" | "otherResidents" | "staff" | "staffNames" | "confirmation"
  >,
): FeedTextCheck {
  const trimmed = normaliseFeedText(raw).trim();
  if (trimmed.length === 0) {
    return {
      text: trimmed,
      problems: [{ problem: "text_required", message: "Write the update for the family." }],
      lint: [],
      confirmed: false,
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
      confirmed: false,
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

  const flagged = findConfirmationTerms(text);
  const confirmed = flagged.length > 0 && confirmationValid(context.confirmation);
  if (flagged.length > 0 && !confirmed) {
    problems.push({
      problem: "needs_confirmation",
      terms: flagged,
      message: `This reads like news the family should hear from a person, or says how the person is: ${[...new Set(flagged.map((t) => t.found))].join(", ")}. Tell the family by phone first. A manager can confirm it may be published, with a reason.`,
    });
  }

  const residents = new Set(
    outermost(
      context.otherResidents.flatMap((resident) => {
        const forms = residentNameForms(resident, context.person);
        return [
          ...forms.anyCase.flatMap((form) => findNameMentions(text, form, { ignoreCase: true })),
          ...forms.capitalised.flatMap((form) => findNameMentions(text, form)),
        ];
      }),
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
      for (const mention of findNameMentions(text, member.familyName, { ignoreCase: true })) {
        surnames.add(mention.found);
      }
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
  return { text, problems, lint: feedReadabilityLint(text), confirmed };
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
  /** When flagged words were published on a manager's confirmation: who and why (audited). */
  readonly confirmation: { readonly by: string; readonly reason: string } | null;
}

export type FeedComposeProblem =
  | FeedTextProblem
  | { readonly problem: "wrong_person"; readonly message: string }
  | { readonly problem: "person_record_closed"; readonly message: string }
  | {
      readonly problem: "publishing_held";
      readonly holds: readonly FeedPublishingHold[];
      readonly message: string;
    }
  | { readonly problem: "in_future"; readonly message: string }
  | { readonly problem: "not_for_the_feed"; readonly message: string }
  | { readonly problem: "visit_in_progress"; readonly message: string }
  | { readonly problem: "accompaniment_purpose_required"; readonly message: string }
  | { readonly problem: "note_not_marked_shareable"; readonly message: string }
  | { readonly problem: "photo_not_marked_for_feed"; readonly message: string }
  | { readonly problem: "photo_basis_missing"; readonly message: string }
  | { readonly problem: "photo_shows_other_people"; readonly message: string }
  | { readonly problem: "unknown_care_plan_domain"; readonly message: string }
  | { readonly problem: "care_plan_domain_not_for_feed"; readonly message: string };

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

const HOLD_MESSAGES: Readonly<Record<FeedPublishingHold, string>> = {
  in_hospital: "the person is in hospital",
  incident_awaiting_next_of_kin: "an incident is waiting for the next of kin to be told",
  candour_step_pending: "a duty of candour step is open",
};

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
  const holds = feedPublishingHolds({
    personStatus: context.person.status,
    openIncidents: context.openIncidents,
    candourStates: context.candourStates,
  });
  if (holds.length > 0) {
    return refuse([
      {
        problem: "publishing_held",
        holds,
        message: `Updates for this person are on hold because ${holds.map((h) => HOLD_MESSAGES[h]).join(" and ")}. The family hears from a person first.`,
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
    confirmation: null,
  };
  const confirmation = (check: FeedTextCheck | null) =>
    check?.confirmed && context.confirmation
      ? { by: context.confirmation.by, reason: context.confirmation.reason.trim() }
      : null;
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
      const result = phrased("activity", key, fill(key, { name, activity: check.text }));
      return { ...result, item: { ...result.item, confirmation: confirmation(check) } };
    }
    case "visit": {
      if (source.endedAt === null) {
        return refuse([
          {
            problem: "visit_in_progress",
            message: "A visit is shared with the family only once it has ended.",
          },
        ]);
      }
      if (source.visitKind === "accompaniment") {
        if (source.accompanimentPurpose === null) {
          return refuse([
            {
              problem: "accompaniment_purpose_required",
              message: "Record why a member of staff went with the person.",
            },
          ]);
        }
        if (source.accompanimentPurpose !== "planned_appointment") {
          return refuse([
            {
              problem: "not_for_the_feed",
              message:
                "Unplanned and emergency appointments are told to the family by phone, not in the feed.",
            },
          ]);
        }
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
          confirmation: confirmation(check),
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
          confirmation: confirmation(check),
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
      if (!carePlanDomainMayAppear(source.domain)) {
        return refuse([
          {
            problem: "care_plan_domain_not_for_feed",
            message:
              "Updates to this care plan section are not announced in the feed. Family members the sharing decision allows still see the section itself.",
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
 * who saw it is told it was taken down (`FEED_WITHDRAWN_NOTICE`, HZ-061). A notification still
 * waiting for it is re-checked (`recheckPendingNotification`) and cancelled if nothing is left.
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
    readonly photoDocumentId?: string | null;
    readonly withdrawnAt: Date | null;
  }[],
  basis: FeedPhotoBasis,
): string[] {
  if (basis.ok) return [];
  return items
    .filter(
      (i) => (i.kind === "photo" || (i.photoDocumentId ?? null) !== null) && i.withdrawnAt === null,
    )
    .map((i) => i.id);
}
