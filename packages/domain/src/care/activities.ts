import type { PersonStatus } from "../people/lifecycle";

/**
 * Activities and wellbeing, and the visiting log (master prompt 10.1; care.md section 2
 * `activity_record` and `visit_log`; register row CARE-014). Both are append-only point-of-care
 * entries written on the phone, offline when needed.
 *
 * Visiting follows Regulation 9A of the Health and Social Care Act 2008 (Regulated Activities)
 * Regulations 2014 (visiting and accompanying, in force from 6 April 2024): people in care homes
 * can receive visitors, go out on visits and be accompanied to hospital and other appointments.
 * Any restriction applied to a visit is recorded with the reason it was needed.
 *
 * Also here, care.md section 4 rule 12: people who are discharged, deceased or archived are
 * read-only, except for post-event records (after-death care, property return, the medical
 * examiner pack, and notes about them).
 */

export const ACTIVITY_FORMATS = ["group", "one_to_one"] as const;
export type ActivityFormat = (typeof ACTIVITY_FORMATS)[number];

export const ACTIVITY_ATTENDANCE = ["attended", "partly_attended", "declined", "not_able"] as const;
export type ActivityAttendance = (typeof ACTIVITY_ATTENDANCE)[number];

/** How the person engaged, in words staff observed: an observation, not a score. */
export const ACTIVITY_ENGAGEMENT = [
  "engaged_throughout",
  "engaged_some_of_the_time",
  "engaged_briefly",
  "did_not_engage",
] as const;
export type ActivityEngagement = (typeof ACTIVITY_ENGAGEMENT)[number];

export interface ActivityInput {
  readonly format: ActivityFormat;
  /** Shared by every person's record of the same group session. */
  readonly groupSessionId: string | null;
  readonly attendance: ActivityAttendance;
  readonly engagement: ActivityEngagement | null;
}

export type FieldCheck<F extends string> =
  | { readonly ok: true }
  | { readonly ok: false; readonly field: F; readonly message: string };

const TOOK_PART: readonly ActivityAttendance[] = ["attended", "partly_attended"];

export function checkActivity(input: ActivityInput): FieldCheck<"groupSessionId" | "engagement"> {
  if (input.format === "group" && input.groupSessionId === null) {
    return {
      ok: false,
      field: "groupSessionId",
      message: "Record which group session this was, so attendance can be counted.",
    };
  }
  if (input.format === "one_to_one" && input.groupSessionId !== null) {
    return {
      ok: false,
      field: "groupSessionId",
      message: "A one-to-one activity is not part of a group session.",
    };
  }
  const tookPart = TOOK_PART.includes(input.attendance);
  if (tookPart && input.engagement === null) {
    return { ok: false, field: "engagement", message: "Record how the person engaged." };
  }
  if (!tookPart && input.engagement !== null) {
    return {
      ok: false,
      field: "engagement",
      message: "Engagement is recorded only when the person took part.",
    };
  }
  return { ok: true };
}

export const VISIT_KINDS = ["facilitated_visit", "visit_out", "accompaniment"] as const;
export type VisitKind = (typeof VISIT_KINDS)[number];

export interface VisitInput {
  readonly kind: VisitKind;
  readonly contactId: string | null;
  readonly visitorName: string | null;
  readonly startedAt: Date;
  /** Null while a visit out or an accompaniment is still going on. */
  readonly endedAt: Date | null;
  readonly restrictionsApplied: boolean;
  readonly restrictionReason: string | null;
}

const filled = (value: string | null | undefined) => (value?.trim().length ?? 0) > 0;

export function checkVisit(
  input: VisitInput,
  now: Date,
): FieldCheck<"visitor" | "endedAt" | "restrictionReason"> {
  if (input.contactId === null && !filled(input.visitorName)) {
    return {
      ok: false,
      field: "visitor",
      message: "Choose the visitor from the person's contacts or write their name.",
    };
  }
  if (input.endedAt !== null) {
    if (input.endedAt.getTime() < input.startedAt.getTime()) {
      return { ok: false, field: "endedAt", message: "The visit cannot end before it started." };
    }
    if (input.endedAt.getTime() > now.getTime()) {
      return { ok: false, field: "endedAt", message: "The end of the visit is in the future." };
    }
  }
  if (input.restrictionsApplied && !filled(input.restrictionReason)) {
    return {
      ok: false,
      field: "restrictionReason",
      message: "Regulation 9A: say why a restriction was needed for this visit.",
    };
  }
  if (!input.restrictionsApplied && input.restrictionReason !== null) {
    return {
      ok: false,
      field: "restrictionReason",
      message: "A reason is recorded only when a restriction was applied.",
    };
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------
// Rule 12: closed records
// ------------------------------------------------------------------------------------------------

export const CLOSED_PERSON_STATUSES: readonly PersonStatus[] = [
  "discharged",
  "deceased",
  "archived",
];

export function isClosedRecord(status: PersonStatus): boolean {
  return CLOSED_PERSON_STATUSES.includes(status);
}

/** Post-event records (after-death care, property return, notes) stay writable on a closed record. */
export function canWriteForPerson(
  status: PersonStatus,
  kind: "care_record" | "post_event",
): boolean {
  return kind === "post_event" || !isClosedRecord(status);
}
