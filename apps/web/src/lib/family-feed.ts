import type { FeedPreview } from "@harbour/contracts";
import { FEED_SOURCE_MAX_AGE_DAYS } from "@harbour/domain";
import type { ActionResult, FieldProblem } from "./outcome";
import { collectedRefusal } from "./outcome";

/**
 * Family updates on the web (comms.md rules 6 to 12; COMMS-001; HZ-022, HZ-060, HZ-061). The API
 * composes every update and decides what may be published; these helpers only choose which
 * records to offer, put each problem the API found at the field it is about, and decide which
 * actions to show.
 */

export const FEED_PUBLISH = "comms.feed.publish";
export const FEED_WITHDRAW = "comms.feed.withdraw";
export const FEED_READ = "comms.feed.read";

export const FEED_SOURCE_KINDS = ["shared_note", "activity", "photo"] as const;
export type FeedSourceKind = (typeof FEED_SOURCE_KINDS)[number];

export const FEED_WITHDRAWAL_REASONS = [
  "source_corrected",
  "published_in_error",
  "person_asked",
  "photo_consent_withdrawn",
] as const;
export type FeedWithdrawalReason = (typeof FEED_WITHDRAWAL_REASONS)[number];

/** Limits the API checks; the form checks them first so the person is told at the field. */
export const FEED_TEXT_MAX = 1000;
export const CONFIRMATION_MAX = 500;
/** Records older than this are not offered, and the API refuses them (HZ-061). */
export const RECENT_DAYS = FEED_SOURCE_MAX_AGE_DAYS;

/** The "Updates" link in the side bar: for a family member's portal session. */
export function familyUpdatesShown(permissions: readonly string[]): boolean {
  return permissions.includes(FEED_READ);
}

/**
 * A family member's portal session: the family portal permission and nothing that reads the
 * staff record. Their home is the updates page.
 */
export function isPortalOnly(permissions: readonly string[]): boolean {
  return permissions.includes("comms.portal.family") && !permissions.includes("people.person.read");
}

/** The words of the update a record would carry, for the form's field names. */
export type FeedField = "source" | "text" | "caption" | "onlyThisPerson" | "confirmationReason";

const TEXT_PROBLEMS = new Set([
  "text_required",
  "text_too_long",
  "clinical_term",
  "names_another_resident",
  "names_staff_surname",
  "contact_details",
  "long_number",
]);

/** Problems with the whole update (holds, a closed record): said once, at no one field. */
const UPDATE_PROBLEMS = new Set(["publishing_held", "person_record_closed"]);

/**
 * The field a problem is about: the words for a note or a photo's caption, the check that nobody
 * else is in a photo, the confirmation reason, or otherwise the record chosen; null for a problem
 * with the update as a whole (publishing is held, or the record is closed).
 */
export function feedProblemField(problem: string, kind: FeedSourceKind): FeedField | null {
  if (TEXT_PROBLEMS.has(problem)) return kind === "photo" ? "caption" : "text";
  if (problem === "needs_confirmation") return "confirmationReason";
  if (problem === "photo_shows_other_people") return "onlyThisPerson";
  if (UPDATE_PROBLEMS.has(problem)) return null;
  return "source";
}

/**
 * A preview's problems as a refusal the form shows: each at its field, in the order the API gave
 * them, and the whole-update problems in the summary only. Null when there are none.
 */
export function previewRefusal(
  preview: Pick<FeedPreview, "ok" | "problems">,
  kind: FeedSourceKind,
): ActionResult<never> | null {
  if (preview.ok || preview.problems.length === 0) return null;
  const atFields: FieldProblem[] = [];
  const general: string[] = [];
  for (const { problem, message } of preview.problems) {
    const field = feedProblemField(problem, kind);
    if (field) atFields.push({ field, message });
    else general.push(message);
  }
  const fielded = collectedRefusal(atFields);
  const code = preview.problems.some((p) => p.problem === "publishing_held") ? "held" : "invalid";
  if (!fielded || fielded.ok) return { ok: false, code, message: general.join(" ") };
  return {
    ...fielded,
    code,
    // Problems at no field lead the summary, so a hold is read before the wording.
    message: [...general, fielded.message].join(" "),
  };
}

/** Whether a preview asks for a manager's confirmation with a reason (rule 12). */
export function needsConfirmation(preview: Pick<FeedPreview, "problems"> | null): boolean {
  return preview?.problems.some((p) => p.problem === "needs_confirmation") ?? false;
}

/** A record that can be the source of an update, as the form lists it. */
export interface SourceOption {
  readonly id: string;
  readonly kind: FeedSourceKind;
  readonly occurredAt: string;
  /** What staff see to choose it: the note's category, the activity or the photo's title. */
  readonly label: string;
}

interface Recorded {
  readonly id: string;
  readonly occurredAt: string;
  readonly superseded: boolean;
}

const recent = (iso: string, now: Date) =>
  now.getTime() - Date.parse(iso) <= RECENT_DAYS * 24 * 60 * 60 * 1000 &&
  Date.parse(iso) <= now.getTime();

/**
 * The records offered as sources, newest first: notes and activities from the last two weeks
 * that no correction has replaced (the API refuses a corrected record too), and the person's
 * photos added for the family feed. Identification and care photos are never offered (HZ-022).
 */
export function sourceOptions(
  input: {
    readonly notes: readonly (Recorded & { readonly category: string })[];
    readonly activities: readonly (Recorded & { readonly activity: string })[];
    readonly photos: readonly {
      readonly id: string;
      readonly title: string;
      readonly category: string;
      readonly createdAt: string;
      readonly contentType: string;
      readonly status: string;
    }[];
  },
  now: Date,
  noteLabel: (category: string) => string,
): Record<FeedSourceKind, SourceOption[]> {
  const newestFirst = (a: SourceOption, b: SourceOption) =>
    Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
  return {
    shared_note: input.notes
      .filter((n) => !n.superseded && recent(n.occurredAt, now))
      .map((n) => ({
        id: n.id,
        kind: "shared_note" as const,
        occurredAt: n.occurredAt,
        label: noteLabel(n.category),
      }))
      .sort(newestFirst),
    activity: input.activities
      .filter((a) => !a.superseded && recent(a.occurredAt, now))
      .map((a) => ({
        id: a.id,
        kind: "activity" as const,
        occurredAt: a.occurredAt,
        label: a.activity,
      }))
      .sort(newestFirst),
    photo: input.photos
      .filter(
        (p) =>
          p.category === "feed_photo" &&
          p.status === "available" &&
          p.contentType.startsWith("image/"),
      )
      .map((p) => ({
        id: p.id,
        kind: "photo" as const,
        occurredAt: p.createdAt,
        label: p.title,
      }))
      .sort(newestFirst),
  };
}

/** The request the form sends for a chosen record and what was typed. */
export interface FeedDraft {
  readonly kind: FeedSourceKind;
  readonly sourceId: string;
  readonly text: string;
  readonly caption: string;
  readonly onlyThisPerson: boolean;
  readonly confirmationReason: string;
}

export type PublishSource =
  | { readonly kind: "shared_note"; readonly noteId: string; readonly text: string }
  | { readonly kind: "activity"; readonly activityId: string }
  | {
      readonly kind: "photo";
      readonly documentId: string;
      readonly caption: string | null;
      readonly onlyThisPerson: boolean;
    };

/** The source as the API takes it: only the fields its kind uses. */
export function publishSource(draft: FeedDraft): PublishSource {
  switch (draft.kind) {
    case "shared_note":
      return { kind: "shared_note", noteId: draft.sourceId, text: draft.text.trim() };
    case "activity":
      return { kind: "activity", activityId: draft.sourceId };
    case "photo":
      return {
        kind: "photo",
        documentId: draft.sourceId,
        caption: draft.caption.trim() || null,
        onlyThisPerson: draft.onlyThisPerson,
      };
  }
}

/**
 * What the form finds before asking the API: a record chosen, words for a note, lengths within
 * the limits. The API checks everything again.
 */
export function draftProblems(
  draft: FeedDraft,
  words: {
    readonly chooseSource: string;
    readonly textRequired: string;
    readonly tooLong: (max: number) => string;
  },
): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (!draft.sourceId) problems.push({ field: "source", message: words.chooseSource });
  if (draft.kind === "shared_note") {
    const text = draft.text.trim();
    if (!text) problems.push({ field: "text", message: words.textRequired });
    else if (text.length > FEED_TEXT_MAX)
      problems.push({ field: "text", message: words.tooLong(FEED_TEXT_MAX) });
  }
  if (draft.kind === "photo" && draft.caption.trim().length > FEED_TEXT_MAX) {
    problems.push({ field: "caption", message: words.tooLong(FEED_TEXT_MAX) });
  }
  if (draft.confirmationReason.trim().length > CONFIRMATION_MAX) {
    problems.push({ field: "confirmationReason", message: words.tooLong(CONFIRMATION_MAX) });
  }
  return problems;
}
