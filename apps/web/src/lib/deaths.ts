import type { DeathView } from "@harbour/contracts";
import { DEATH_REASON_MIN } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import { type FormLike, readDateTimeField, type TimeProblem } from "./uk-time";

/**
 * The death record screens (Phase 2 slice 63; SAFE-014; HZ-013): pure and unit tested. The API
 * (`/v1/deaths`) runs every rule. Two clinical rules shape these helpers:
 * - whether the death was expected, and whether it may be unnatural, is the clinician's judgement,
 *   never Harbour's; until it is recorded the steps assume the safer answer, so the police steps
 *   stay listed;
 * - the regulator's death notification, the medical examiner information and the LeDeR
 *   notification are completed in the notification centre and only linked from the record, never
 *   recorded on it.
 */

export const DEATHS_READ = "safety.incident.read";
export const DEATHS_MANAGE = "safety.incident.manage";

export type DeathStepKey = DeathView["steps"][number]["step"];

/** Steps done in the notification centre: linked from the record, never recorded on it. */
export const NOTIFICATION_STEPS: readonly DeathStepKey[] = [
  "cqc_reg16_notification",
  "medical_examiner_pack",
  "leder_notification",
];

/** Steps that stay listed while the judgement is missing (the safer answer is assumed). */
export const POLICE_STEPS: readonly DeathStepKey[] = [
  "police_informed",
  "preserve_room_and_equipment",
];

/** A reason or review text's shortest length: the domain's own rule, so web and API agree. */
export const DEATH_TEXT_MIN = DEATH_REASON_MIN;
export const DEATH_NOTE_MAX = 2_000;
export const DEATH_REFERENCE_MAX = 100;
export const DEATH_REVIEW_MAX = 10_000;
export const JUDGED_BY_MAX = 200;

export function deathsShown(permissions: readonly string[]): boolean {
  return permissions.includes(DEATHS_READ);
}

export function canManageDeaths(permissions: readonly string[]): boolean {
  return permissions.includes(DEATHS_MANAGE);
}

/** A step recorded on the death record itself: never a notification step or the mortality review. */
export function recordableHere(step: string): boolean {
  return !(NOTIFICATION_STEPS as readonly string[]).includes(step) && step !== "mortality_review";
}

/**
 * Whether a step may be recorded as not needed: never a police step while the clinician's
 * judgement is missing (HZ-013), because the safer answer stands until it is recorded.
 */
export function notNeededAllowed(step: string, missingFacts: readonly string[]): boolean {
  return !(missingFacts.length > 0 && (POLICE_STEPS as readonly string[]).includes(step));
}

export function isNotificationStep(step: string): boolean {
  return (NOTIFICATION_STEPS as readonly string[]).includes(step);
}

/**
 * The steps to list, in the API's order. While the judgement is missing the police steps are
 * always listed, even if the API has not sent them, so they cannot be overlooked.
 */
export function stepsToShow(view: Pick<DeathView, "steps" | "missingFacts">): DeathView["steps"] {
  const steps = [...view.steps];
  if (view.missingFacts.length > 0) {
    for (const step of POLICE_STEPS) {
      if (!steps.some((s) => s.step === step)) {
        steps.push({
          step,
          state: "outstanding",
          at: null,
          notificationId: null,
          notificationStatus: null,
          reason: null,
        });
      }
    }
  }
  return steps;
}

/** The record's status as an icon and a word; an unknown one is a warning, never a fact. */
export function deathStatusChip(status: string, t: Translator): SafetyChip {
  switch (status) {
    case "open":
      return { status: "due", icon: "clock", label: t("deaths.status", { status }) };
    case "closed":
      return { status: "neutral", icon: "circle-check", label: t("deaths.status", { status }) };
    case "withdrawn":
      return { status: "neutral", icon: "circle-minus", label: t("deaths.status", { status }) };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("deaths.status", { status: "unknown" }),
      };
  }
}

/** A step's state as an icon and a word. */
export function deathStepChip(state: string, t: Translator): SafetyChip {
  switch (state) {
    case "done":
      return { status: "neutral", icon: "circle-check", label: t("deaths.stepState", { state }) };
    case "not_needed":
      return { status: "neutral", icon: "circle-minus", label: t("deaths.stepState", { state }) };
    case "waiting":
      return { status: "info", icon: "clock", label: t("deaths.stepState", { state }) };
    case "outstanding":
      return { status: "due", icon: "circle-alert", label: t("deaths.stepState", { state }) };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("deaths.stepState", { state: "unknown" }),
      };
  }
}

/** The mortality review against its due time, in words with an icon. */
export function reviewChip(
  review: { readonly reviewedAt: string | null; readonly overdue: boolean },
  t: Translator,
): SafetyChip {
  if (review.reviewedAt) {
    return { status: "neutral", icon: "circle-check", label: t("deaths.review.done") };
  }
  return review.overdue
    ? { status: "overdue", icon: "circle-alert", label: t("deaths.review.overdue") }
    : { status: "due", icon: "clock", label: t("deaths.review.due") };
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

const yesNo = (form: FormLike, name: string): boolean | null => {
  const value = text(form, name);
  return value === "yes" ? true : value === "no" ? false : null;
};

/** The clinician's judgement: expected or not, possibly unnatural or not, and whose it is. */
export function readJudgement(
  form: FormLike,
  t: Translator,
  options: { readonly version: number },
): Read<{ expected: boolean; possiblyUnnatural: boolean; judgedBy: string; version: number }> {
  const errors: Record<string, string> = {};
  const expected = yesNo(form, "expected");
  if (expected === null) errors.expected = t("deaths.judgement.expectedError");
  const possiblyUnnatural = yesNo(form, "possiblyUnnatural");
  if (possiblyUnnatural === null) errors.possiblyUnnatural = t("deaths.judgement.unnaturalError");
  const judgedBy = text(form, "judgedBy");
  if (judgedBy.length < 3 || judgedBy.length > JUDGED_BY_MAX) {
    errors.judgedBy = t("deaths.judgement.judgedByError", { max: JUDGED_BY_MAX });
  }
  if (Object.keys(errors).length > 0 || expected === null || possiblyUnnatural === null) {
    return { ok: false, errors };
  }
  return { ok: true, body: { expected, possiblyUnnatural, judgedBy, version: options.version } };
}

/** Recording a step here as done, or as not needed with the reason. */
export function readDeathStep(
  form: FormLike,
  t: Translator,
  options: {
    readonly id: string;
    readonly step: DeathStepKey;
    readonly now?: Date;
    /** The judgement facts still missing (`DeathView.missingFacts`). */
    readonly missingFacts?: readonly string[];
  },
): Read<{
  id: string;
  step: DeathStepKey;
  outcome: "done" | "not_needed";
  at: string;
  note: string | null;
  reference: string | null;
}> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  if (!recordableHere(options.step)) {
    return { ok: false, errors: { outcome: t("deaths.step.notHere") } };
  }
  const outcome = text(form, "outcome");
  if (outcome !== "done" && outcome !== "not_needed") {
    errors.outcome = t("deaths.step.outcomeError");
  } else if (
    outcome === "not_needed" &&
    !notNeededAllowed(options.step, options.missingFacts ?? [])
  ) {
    errors.outcome = t("deaths.step.policeNotNeededRefused");
  }
  const at = readDateTimeField(form, "at", {
    subject: t("deaths.step.atSubject"),
    t,
    ...(options.now ? { now: options.now } : {}),
  });
  if (!at.ok) {
    errors.at = (at as TimeProblem).message;
    parts.at = (at as TimeProblem).parts;
  }
  const note = text(form, "note");
  if (note.length > DEATH_NOTE_MAX)
    errors.note = t("deaths.step.noteError", { max: DEATH_NOTE_MAX });
  if (outcome === "not_needed" && note.length < DEATH_TEXT_MIN) {
    errors.note = t("deaths.step.reasonError", { min: DEATH_TEXT_MIN });
  }
  const reference = text(form, "reference");
  if (reference.length > DEATH_REFERENCE_MAX) {
    errors.reference = t("deaths.step.referenceError", { max: DEATH_REFERENCE_MAX });
  }
  if (Object.keys(errors).length > 0 || !at.ok || !at.instant) {
    return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
  }
  return {
    ok: true,
    body: {
      id: options.id,
      step: options.step,
      outcome: outcome as "done" | "not_needed",
      at: at.instant,
      note: note || null,
      reference: reference || null,
    },
  };
}

/** The mortality review: findings and lessons, in words. */
export function readDeathReview(
  form: FormLike,
  t: Translator,
  options: { readonly version: number },
): Read<{ findings: string; lessons: string; version: number }> {
  const errors: Record<string, string> = {};
  const findings = text(form, "findings");
  const lessons = text(form, "lessons");
  if (findings.length < DEATH_TEXT_MIN || findings.length > DEATH_REVIEW_MAX) {
    errors.findings = t("deaths.review.findingsError", {
      min: DEATH_TEXT_MIN,
      max: DEATH_REVIEW_MAX,
    });
  }
  if (lessons.length < DEATH_TEXT_MIN || lessons.length > DEATH_REVIEW_MAX) {
    errors.lessons = t("deaths.review.lessonsError", {
      min: DEATH_TEXT_MIN,
      max: DEATH_REVIEW_MAX,
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { findings, lessons, version: options.version } };
}

/** Closing needs nothing but the version; the API refuses while anything is outstanding. */
export function readCloseDeath(options: { readonly version: number }): Read<{ version: number }> {
  return { ok: true, body: { version: options.version } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exit record a new death record opens from, from the page's address. */
export function exitRecordFrom(value: string | undefined): string | null {
  return value && UUID.test(value) ? value : null;
}

/** Where a notification step is completed: the notification centre's page for it. */
export function notificationHref(notificationId: string | null): string | null {
  return notificationId && UUID.test(notificationId)
    ? `/notifications/statutory/${notificationId}`
    : null;
}
