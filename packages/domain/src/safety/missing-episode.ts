/**
 * A missing person episode and the Herbert Protocol profile (safety.md Phase 2 rule 5 and slice
 * 37; SAFE-015; HZ-127, HZ-013). The episode belongs to a missing person (or absconding) incident:
 * its timeline (last seen, noticed missing, search started, each area searched, sightings, the
 * police called with their reference, found, the welfare check on return, the debrief), the police
 * call target from the moment the person is noticed missing (`missingPersonState`), and the
 * profile handed to the police. The profile is prefilled from the person's record for staff to
 * check, and is out of date `herbert_protocol.review_months` after its last review.
 */

import {
  type MissingEvent,
  type MissingEventKind,
  type MissingState,
  missingPersonState,
} from "./missing-person";
import type { SafetyPhase2Rates } from "./phase2-rates";

export const MISSING_EPISODE_STATUSES = ["open", "found", "closed"] as const;
export type MissingEpisodeStatus = (typeof MISSING_EPISODE_STATUSES)[number];

/** The timeline's kinds: the search's steps, and entries that may repeat (search, sighting, note). */
export const MISSING_TIMELINE_KINDS = [
  "last_seen",
  "noticed_missing",
  "search_started",
  "search",
  "sighting",
  "police_called",
  "found",
  "welfare_check",
  "debrief",
  "note",
] as const;
export type MissingTimelineKind = (typeof MISSING_TIMELINE_KINDS)[number];

/** Kinds recorded once per episode. */
const ONCE: readonly MissingTimelineKind[] = [
  "last_seen",
  "noticed_missing",
  "search_started",
  "police_called",
  "found",
  "welfare_check",
  "debrief",
];
/** Kinds that only make sense while the person is still missing. */
const WHILE_MISSING: readonly MissingTimelineKind[] = [
  "noticed_missing",
  "search_started",
  "search",
  "sighting",
  "police_called",
];
/** Kinds that need the person found first. */
const AFTER_FOUND: readonly MissingTimelineKind[] = ["welfare_check", "debrief"];

/** The shortest note where one is needed (where found, the welfare check, the debrief). */
export const MISSING_NOTE_MIN = 10;

export interface TimelineEntry {
  readonly kind: MissingTimelineKind;
  readonly at: Date;
  readonly reference?: string | null;
  readonly area?: string | null;
  readonly note?: string | null;
}

const isStep = (kind: MissingTimelineKind): kind is MissingEventKind =>
  kind !== "search" && kind !== "sighting" && kind !== "note";

/** The timeline's steps, as the slice 7 rules read them. */
export function timelineEvents(entries: readonly TimelineEntry[]): MissingEvent[] {
  return entries
    .filter((e): e is TimelineEntry & { kind: MissingEventKind } => isStep(e.kind))
    .map((e) => ({ kind: e.kind, at: e.at, ...(e.reference ? { reference: e.reference } : {}) }));
}

/**
 * Why an entry cannot be added: a closed episode; a time later than now; a step already recorded;
 * the police without their reference; a search without where; found without where; a welfare check
 * or debrief before they were found, or without what it found; anything of the search once they are
 * found; or a time that runs the search backwards (`missingPersonState`).
 */
export function timelineEntryProblems(
  status: MissingEpisodeStatus,
  existing: readonly TimelineEntry[],
  entry: TimelineEntry,
  now: Date,
  rates: Pick<SafetyPhase2Rates, "missingPersonPoliceCallMinutes" | "herbertProtocolReviewMonths">,
): string[] {
  const problems: string[] = [];
  if (status === "closed") return ["This episode is closed and cannot change."];
  if (entry.at > now) problems.push("The time cannot be in the future.");
  if (ONCE.includes(entry.kind) && existing.some((e) => e.kind === entry.kind)) {
    problems.push("That is already on the timeline: add a note instead.");
  }
  const found = existing.some((e) => e.kind === "found");
  if (found && WHILE_MISSING.includes(entry.kind)) {
    problems.push("The person has been found: add a note instead.");
  }
  if (!found && AFTER_FOUND.includes(entry.kind)) {
    problems.push("Record that the person was found first.");
  }
  if (entry.kind === "police_called" && !entry.reference?.trim()) {
    problems.push("Record the police reference.");
  }
  if (entry.kind === "search" && !entry.area?.trim()) problems.push("Say where was searched.");
  const needsNote: Partial<Record<MissingTimelineKind, string>> = {
    found: "Say where and how they were found",
    welfare_check: "Say what the welfare check found",
    debrief: "Say what the debrief found and what will change",
    sighting: "Say where they were seen and by whom",
    note: "Write the note",
  };
  const words = needsNote[entry.kind];
  if (words && (entry.note?.trim().length ?? 0) < MISSING_NOTE_MIN) {
    problems.push(`${words}, in at least ${MISSING_NOTE_MIN} characters.`);
  }
  if (problems.length > 0) return problems;
  // The search's steps never run backwards (the slice 7 rule), now with this one.
  const before = missingPersonState(
    {
      events: timelineEvents(existing),
      underDolsOrMha: false,
      immediateRisk: false,
      herbertProfileReviewedOn: null,
    },
    now,
    rates,
  ).problems.filter((p) => p.startsWith("The time for"));
  const after = missingPersonState(
    {
      events: timelineEvents([...existing, entry]),
      underDolsOrMha: false,
      immediateRisk: false,
      herbertProfileReviewedOn: null,
    },
    now,
    rates,
  ).problems.filter((p) => p.startsWith("The time for") && !before.includes(p));
  return after;
}

export interface MissingEpisodeView extends MissingState {
  readonly status: MissingEpisodeStatus;
  /** The timeline, in time order. */
  readonly timeline: readonly TimelineEntry[];
  readonly policeReference: string | null;
  /** What closing needs, in words. */
  readonly closeProblems: readonly string[];
}

/** The episode as it stands, from its timeline and the person's Herbert Protocol profile. */
export function missingEpisodeView(input: {
  readonly status: MissingEpisodeStatus;
  readonly timeline: readonly TimelineEntry[];
  readonly underDolsOrMha: boolean;
  readonly immediateRisk: boolean;
  readonly herbertProfileReviewedOn: Date | null;
  readonly now: Date;
  readonly rates: Pick<
    SafetyPhase2Rates,
    "missingPersonPoliceCallMinutes" | "herbertProtocolReviewMonths"
  >;
}): MissingEpisodeView {
  const timeline = [...input.timeline].sort((a, b) => a.at.getTime() - b.at.getTime());
  const state = missingPersonState(
    {
      events: timelineEvents(timeline),
      underDolsOrMha: input.underDolsOrMha,
      immediateRisk: input.immediateRisk,
      herbertProfileReviewedOn: input.herbertProfileReviewedOn,
    },
    input.now,
    input.rates,
  );
  const closeProblems = [...state.problems];
  if (!timeline.some((e) => e.kind === "noticed_missing")) {
    closeProblems.unshift("Record when the person was noticed missing.");
  }
  return {
    ...state,
    canClose: state.canClose && closeProblems.length === state.problems.length,
    status: input.status,
    timeline,
    policeReference: timeline.find((e) => e.kind === "police_called")?.reference ?? null,
    closeProblems,
  };
}

// ------------------------------------------------------------------------------------------------
// The Herbert Protocol profile
// ------------------------------------------------------------------------------------------------

/** The profile's written parts (data-standards.md, Herbert Protocol fields). */
export const HERBERT_PROFILE_FIELDS = [
  "physicalDescription",
  "distinguishingFeatures",
  "usualClothing",
  "medicalNeeds",
  "mobility",
  "communication",
  "placesLikely",
  "peopleLikely",
  "routines",
  "phoneOrTracker",
  "previousEpisodes",
  "approach",
] as const;
export type HerbertProfileField = (typeof HERBERT_PROFILE_FIELDS)[number];

export type HerbertProfileText = { readonly [K in HerbertProfileField]: string | null };

/** The shortest answer for the parts the police need first. */
export const HERBERT_REQUIRED_MIN = 10;

/**
 * Why a profile cannot be saved: the parts the police need first (what the person looks like and
 * where they may go), and a review date not later than today.
 */
export function herbertProfileProblems(
  profile: HerbertProfileText & { readonly reviewedOn: string },
  today: string,
): string[] {
  const problems: string[] = [];
  if ((profile.physicalDescription?.trim().length ?? 0) < HERBERT_REQUIRED_MIN) {
    problems.push(
      `Describe what the person looks like (height, build, hair, eyes), in at least ${HERBERT_REQUIRED_MIN} characters.`,
    );
  }
  if ((profile.placesLikely?.trim().length ?? 0) < HERBERT_REQUIRED_MIN) {
    problems.push(
      `Say where the person may go (earlier homes, work, places they love), in at least ${HERBERT_REQUIRED_MIN} characters.`,
    );
  }
  if (profile.reviewedOn > today) problems.push("The review date cannot be in the future.");
  return problems;
}

/** What the person's record already holds, for prefilling a new profile. */
export interface HerbertRecordFacts {
  readonly addressLines: readonly string[];
  /** The person's communication needs as recorded (Accessible Information Standard). */
  readonly communicationNeeds: readonly string[];
  readonly firstLanguage: string | null;
  readonly interpreterRequired: boolean;
  /** About Me, by section, in the person's own words. */
  readonly aboutMe: {
    readonly howICommunicate?: string | null;
    readonly peopleWhoAreImportant?: string | null;
    readonly pleaseDoAndDoNot?: string | null;
    readonly howAndWhenToSupportMe?: string | null;
  };
  readonly allergies: readonly string[];
}

const joined = (parts: readonly (string | null | undefined)[]): string | null => {
  const kept = parts.map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return kept.length > 0 ? kept.join("\n") : null;
};

/**
 * A new profile prefilled from the record, for staff to check with the person and their family
 * before saving: never saved as it is, and every part says where it came from. Physical
 * description is never prefilled: it must be written by someone who has looked.
 */
export function herbertPrefill(facts: HerbertRecordFacts): HerbertProfileText {
  return {
    physicalDescription: null,
    distinguishingFeatures: null,
    usualClothing: null,
    medicalNeeds: joined(
      facts.allergies.length > 0
        ? [`Allergies (from the record): ${facts.allergies.join(", ")}`]
        : [],
    ),
    mobility: null,
    communication: joined([
      ...facts.communicationNeeds.map((n) => `From the record: ${n}`),
      facts.firstLanguage ? `First language (from the record): ${facts.firstLanguage}` : null,
      facts.interpreterRequired ? "An interpreter is needed (from the record)" : null,
      facts.aboutMe.howICommunicate ? `From About Me: ${facts.aboutMe.howICommunicate}` : null,
    ]),
    placesLikely: joined(
      facts.addressLines.length > 0
        ? [`Home address before moving here (from the record): ${facts.addressLines.join(", ")}`]
        : [],
    ),
    peopleLikely: joined([
      facts.aboutMe.peopleWhoAreImportant
        ? `From About Me: ${facts.aboutMe.peopleWhoAreImportant}`
        : null,
    ]),
    routines: joined([
      facts.aboutMe.howAndWhenToSupportMe
        ? `From About Me: ${facts.aboutMe.howAndWhenToSupportMe}`
        : null,
    ]),
    phoneOrTracker: null,
    previousEpisodes: null,
    approach: joined([
      facts.aboutMe.pleaseDoAndDoNot ? `From About Me: ${facts.aboutMe.pleaseDoAndDoNot}` : null,
    ]),
  };
}

/**
 * When the profile falls out of date: `herbert_protocol.review_months` after its last review, on
 * the same day of the month (the last day where that month is shorter), as the slice 7 rule reads it.
 */
export function herbertReviewDueOn(reviewedOn: string, months: number): string {
  const [y, m, d] = reviewedOn.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const due = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay)));
  return due.toISOString().slice(0, 10);
}
