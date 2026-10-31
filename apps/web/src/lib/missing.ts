import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import { type FormLike, readDateField, readDateTimeField, type TimeProblem } from "./uk-time";

/**
 * The missing person screens and the Herbert Protocol profile (Phase 2 slice 63; SAFE-015;
 * HZ-127): pure and unit tested. The API (`/v1/missing-episodes`, `/v1/people/{id}/herbert-profile`)
 * runs every rule: the police call target, what closing needs, the CQC prompt. These helpers name
 * things in words, put the police call first, and read the forms.
 */

export const MISSING_READ = "safety.incident.read";
export const MISSING_REPORT = "safety.incident.report";
export const MISSING_MANAGE = "safety.incident.manage";

/** Shown to whoever may read incidents (the API's own check). */
export function missingShown(permissions: readonly string[]): boolean {
  return permissions.includes(MISSING_READ);
}

export const TIMELINE_KINDS = [
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
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** Entries that need safety.incident.manage; the rest need safety.incident.report. */
export const MANAGE_ONLY_KINDS: readonly TimelineKind[] = ["welfare_check", "debrief"];

/** The kinds the reader may add: a reporter adds everything except the welfare check and debrief. */
export function kindsFor(permissions: readonly string[]): TimelineKind[] {
  if (permissions.includes(MISSING_MANAGE)) return [...TIMELINE_KINDS];
  if (permissions.includes(MISSING_REPORT)) {
    return TIMELINE_KINDS.filter((k) => !MANAGE_ONLY_KINDS.includes(k));
  }
  return [];
}

export const HERBERT_TEXT_FIELDS = [
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
  "reviewedWith",
] as const;
export type HerbertTextField = (typeof HERBERT_TEXT_FIELDS)[number];

/** Written by someone who has looked or asked; never prefilled, never left empty. */
export const HERBERT_REQUIRED: readonly HerbertTextField[] = [
  "physicalDescription",
  "placesLikely",
];

export function herbertMax(field: HerbertTextField): number {
  if (field === "phoneOrTracker") return 1000;
  if (field === "reviewedWith") return 500;
  return 4000;
}

/** Where the episode stands, as an icon and a word; one the web does not know is a warning. */
export function missingStatusChip(status: string, t: Translator): SafetyChip {
  switch (status) {
    case "open":
      return { status: "overdue", icon: "circle-alert", label: t("missing.status", { status }) };
    case "found":
      return { status: "due", icon: "clock", label: t("missing.status", { status }) };
    case "closed":
      return { status: "done", icon: "circle-check", label: t("missing.status", { status }) };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("missing.status", { status: "unknown" }),
      };
  }
}

export interface PoliceCall {
  readonly status: string;
  readonly policeCallDueAt: string | null;
  readonly policeCallLate: boolean;
  readonly policeReference?: string | null;
  readonly immediateRisk?: boolean;
}

export type PoliceCallState = "called" | "overdue" | "now" | "due" | "not_needed";

/**
 * The police call as the screens put it first: overdue, call now (immediate risk), due by the
 * target, called (a reference recorded), or no longer needed (found or closed before a call).
 */
export function policeCallState(episode: PoliceCall): PoliceCallState {
  if (episode.policeReference) return "called";
  if (episode.status !== "open") return "not_needed";
  if (episode.policeCallLate) return "overdue";
  if (episode.immediateRisk) return "now";
  return episode.policeCallDueAt ? "due" : "now";
}

/** The police call as an icon and words with the target time (formatted by the caller). */
export function policeCallChip(state: PoliceCallState, when: string, t: Translator): SafetyChip {
  const label = t("missing.police.chip", { state, when });
  switch (state) {
    case "overdue":
      return { status: "overdue", icon: "circle-alert", label };
    case "now":
      return { status: "overdue", icon: "triangle-alert", label };
    case "due":
      return { status: "due", icon: "clock", label };
    case "called":
      return { status: "done", icon: "send", label };
    case "not_needed":
      return { status: "neutral", icon: "circle-minus", label };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("missing.status", { status: "unknown" }),
      };
  }
}

type Read<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

function failed<T>(
  errors: Record<string, string>,
  parts: Record<string, readonly string[]> = {},
): Read<T> {
  return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
}

export interface OpenEpisodeBody {
  readonly id: string;
  readonly incidentId: string;
  readonly personId: string;
  readonly immediateRisk: boolean;
  readonly noticedMissingAt: string;
  readonly lastSeenAt: string | null;
}

/** Opening an episode: when they were noticed missing, when last seen, and whether at once. */
export function readOpenEpisode(
  form: FormLike,
  t: Translator,
  options: {
    readonly id: string;
    readonly incidentId: string;
    readonly personId: string;
    readonly now?: Date;
  },
): Read<OpenEpisodeBody> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const now = options.now ? { now: options.now } : {};
  const noticed = readDateTimeField(form, "noticedMissingAt", {
    subject: t("missing.form.noticedSubject"),
    t,
    ...now,
  });
  if (!noticed.ok) {
    errors.noticedMissingAt = (noticed as TimeProblem).message;
    parts.noticedMissingAt = (noticed as TimeProblem).parts;
  }
  const lastSeen = readDateTimeField(form, "lastSeenAt", {
    subject: t("missing.form.lastSeenSubject"),
    t,
    optional: true,
    ...now,
  });
  if (!lastSeen.ok) {
    errors.lastSeenAt = (lastSeen as TimeProblem).message;
    parts.lastSeenAt = (lastSeen as TimeProblem).parts;
  }
  const risk = text(form, "immediateRisk");
  if (risk !== "yes" && risk !== "no") errors.immediateRisk = t("missing.form.riskError");
  const noticedAt = noticed.ok ? noticed.instant : null;
  const lastSeenAt = lastSeen.ok ? lastSeen.instant : null;
  if (noticedAt && lastSeenAt && lastSeenAt > noticedAt) {
    errors.lastSeenAt = t("missing.form.lastSeenAfter");
  }
  if (Object.keys(errors).length > 0 || !noticedAt) return failed(errors, parts);
  return {
    ok: true,
    body: {
      id: options.id,
      incidentId: options.incidentId,
      personId: options.personId,
      immediateRisk: risk === "yes",
      noticedMissingAt: noticedAt,
      lastSeenAt,
    },
  };
}

export interface TimelineBody {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly at: string;
  readonly reference: string | null;
  readonly area: string | null;
  readonly note: string | null;
}

/** A timeline entry: what happened and when; the police called need their reference. */
export function readTimelineEntry(
  form: FormLike,
  t: Translator,
  options: { readonly id: string; readonly now?: Date },
): Read<TimelineBody> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const kindValue = text(form, "kind");
  const kind = (TIMELINE_KINDS as readonly string[]).includes(kindValue)
    ? (kindValue as TimelineKind)
    : null;
  if (!kind) errors.kind = t("missing.timeline.kindError");
  const at = readDateTimeField(form, "at", {
    subject: t("missing.timeline.atSubject"),
    t,
    ...(options.now ? { now: options.now } : {}),
  });
  if (!at.ok) {
    errors.at = (at as TimeProblem).message;
    parts.at = (at as TimeProblem).parts;
  }
  const reference = text(form, "reference");
  const area = text(form, "area");
  const note = text(form, "note");
  if (kind === "police_called" && !reference) {
    errors.reference = t("missing.timeline.referenceError");
  }
  if (reference.length > 100) errors.reference = t("missing.timeline.referenceLong");
  if (area.length > 500) errors.area = t("missing.timeline.areaLong", { max: 500 });
  if (note.length > 4000) errors.note = t("missing.timeline.noteLong", { max: 4000 });
  if (kind === "note" && !note) errors.note = t("missing.timeline.noteError");
  if (Object.keys(errors).length > 0 || !kind || !at.ok || !at.instant) {
    return failed(errors, parts);
  }
  return {
    ok: true,
    body: {
      id: options.id,
      kind,
      at: at.instant,
      reference: reference || null,
      area: area || null,
      note: note || null,
    },
  };
}

export type HerbertBody = Record<HerbertTextField, string | null> & {
  readonly physicalDescription: string;
  readonly placesLikely: string;
  readonly photoDocumentId: string | null;
  readonly reviewedOn: string;
  readonly version: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Saving the profile: every field as staff wrote or checked it. What the person looks like and
 * where they may go must be written; the review date is a real UK date.
 */
export function readHerbertProfile(
  form: FormLike,
  t: Translator,
  options: { readonly version: number; readonly today: string },
): Read<HerbertBody> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const values = {} as Record<HerbertTextField, string | null>;
  for (const field of HERBERT_TEXT_FIELDS) {
    const value = text(form, field);
    if (value.length > herbertMax(field)) {
      errors[field] = t("herbert.form.tooLong", { max: herbertMax(field) });
    }
    values[field] = value || null;
  }
  for (const field of HERBERT_REQUIRED) {
    if (!values[field]) errors[field] = t("herbert.form.required", { field });
  }
  const reviewed = readDateField(form, "reviewedOn", {
    subject: t("herbert.form.reviewedSubject"),
    t,
  });
  if (!reviewed.ok) {
    errors.reviewedOn = (reviewed as TimeProblem).message;
    parts.reviewedOn = (reviewed as TimeProblem).parts;
  } else if (reviewed.date && reviewed.date > options.today) {
    errors.reviewedOn = t("herbert.form.reviewedFuture");
  }
  const photo = text(form, "photoDocumentId");
  if (Object.keys(errors).length > 0 || !reviewed.ok || !reviewed.date) {
    return failed(errors, parts);
  }
  return {
    ok: true,
    body: {
      ...values,
      physicalDescription: values.physicalDescription as string,
      placesLikely: values.placesLikely as string,
      photoDocumentId: UUID.test(photo) ? photo : null,
      reviewedOn: reviewed.date,
      version: options.version,
    },
  };
}

/** A prefilled value names where it came from ("From the record:", "From About Me:"). */
export function prefillSources(value: string | null): string[] {
  if (!value) return [];
  const sources = new Set<string>();
  for (const line of value.split("\n")) {
    if (/^From About Me:/.test(line)) sources.add("about_me");
    else if (/from the record/i.test(line)) sources.add("record");
  }
  return [...sources];
}
