import type { Severity } from "../platform/notifications";
import type { TaskStatus } from "../platform/tasks";
import { TERMINAL_TASK_STATUSES } from "../platform/tasks";
import { fromUkWallClock, toUkWallClock } from "../shared/time";
import type { CareTaskKind } from "./assessment";
import type { News2Band } from "./news2";

/**
 * Shift handover (care.md rule 8, hazard HZ-018). The handover compiles itself from the shift's
 * records by rule, so it never depends on memory: falls, NEWS2 results that ask for more than
 * routine monitoring, incidents, urgent alerts nobody has acknowledged, new body-map marks, notes
 * staff tagged for the handover, tasks overdue, skipped or unfinished at the end of the shift, MUST
 * follow-ups and refusals. Compiled items can be annotated but never removed; items that sync after
 * compilation are appended as late additions, and anyone who acknowledged before them must
 * acknowledge the new items they can see too.
 */

// ------------------------------------------------------------------------------------------------
// Shifts
// ------------------------------------------------------------------------------------------------

/** Rate-table keys for the default two-shift pattern (until rotas define shifts per location). */
export const HANDOVER_RATE_KEYS = {
  dayShiftStartMinute: "handover.day_shift_start_minute",
  nightShiftStartMinute: "handover.night_shift_start_minute",
  /**
   * How long after a shift ends the nurse in charge is told that nobody on the incoming shift has
   * acknowledged its handover (H-153, to verify).
   */
  acknowledgementGraceMinutes: "handover.acknowledgement_grace_minutes",
  /**
   * Within this long before a shift ends, the phone shows the running shift's own handover first;
   * before then, the one the shift received (H-420, HZ-018; policy, to verify).
   */
  previewLeadMinutes: "handover.preview_lead_minutes",
} as const;

export interface ShiftStart {
  /** For example "day" and "night", or "early", "late" and "night". */
  readonly name: string;
  /** Minutes after midnight, UK local time (07:30 is 450). */
  readonly minuteOfDay: number;
}

/** The shifts of a location's day, in order; the last runs into the next morning. */
export interface ShiftPattern {
  readonly starts: readonly ShiftStart[];
}

export interface ShiftWindow {
  readonly name: string;
  readonly start: Date;
  /** Exclusive. A shift over a clock change is an hour shorter or longer. */
  readonly end: Date;
}

export class ShiftPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShiftPatternError";
  }
}

const MINUTES_IN_DAY = 24 * 60;

/** The default day and night pattern from the two rate-table start times. */
export function twoShiftPattern(dayStartMinute: number, nightStartMinute: number): ShiftPattern {
  return {
    starts: [
      { name: "day", minuteOfDay: dayStartMinute },
      { name: "night", minuteOfDay: nightStartMinute },
    ],
  };
}

function checkPattern(pattern: ShiftPattern): void {
  const minutes = pattern.starts.map((s) => s.minuteOfDay);
  const valid =
    minutes.length >= 2 &&
    minutes.every((m) => Number.isInteger(m) && m >= 0 && m < MINUTES_IN_DAY) &&
    minutes.every((m, i) => i === 0 || m > (minutes[i - 1] ?? -1)) &&
    pattern.starts.every((s) => s.name.trim().length > 0);
  if (!valid) {
    throw new ShiftPatternError(
      "A shift pattern needs at least two named shifts with start times in order, between 00:00 and 23:59.",
    );
  }
}

function startOn(year: number, month: number, day: number, minuteOfDay: number): Date {
  const d = new Date(Date.UTC(year, month - 1, day));
  return fromUkWallClock(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  );
}

/** The shift running at an instant, in UK local time. */
export function shiftAt(instant: Date, pattern: ShiftPattern): ShiftWindow {
  checkPattern(pattern);
  const starts = pattern.starts;
  const w = toUkWallClock(instant);
  const minute = w.hour * 60 + w.minute;
  const on = (dayOffset: number, start: ShiftStart) =>
    startOn(w.year, w.month, w.day + dayOffset, start.minuteOfDay);
  const index = starts.findLastIndex((s) => s.minuteOfDay <= minute);
  const first = starts[0] as ShiftStart;
  const last = starts.at(-1) as ShiftStart;
  if (index === -1) {
    // Before the first start of the day: the last shift of yesterday.
    return { name: last.name, start: on(-1, last), end: on(0, first) };
  }
  const current = starts[index] as ShiftStart;
  const next = starts[index + 1];
  return {
    name: current.name,
    start: on(0, current),
    end: next ? on(0, next) : on(1, first),
  };
}

/** The shift after this one: the people who receive the handover. */
export function nextShift(shift: ShiftWindow, pattern: ShiftPattern): ShiftWindow {
  return shiftAt(shift.end, pattern);
}

// ------------------------------------------------------------------------------------------------
// Sources and items
// ------------------------------------------------------------------------------------------------

/** Ordered by how urgently the incoming shift needs to know. */
export const HANDOVER_ITEM_KINDS = [
  "fall",
  "news2",
  "incident",
  "alert",
  "body_map_mark",
  "flagged_note",
  "overdue_task",
  "skipped_task",
  "unfinished_task",
  "must_follow_up",
  "refusal",
] as const;
export type HandoverItemKind = (typeof HANDOVER_ITEM_KINDS)[number];

/**
 * The note tags the handover reads. They are a fixed vocabulary that the note form offers as
 * choices; free-text tags are never matched, so a typed "fell" or "declined" cannot slip through.
 * `handover` ("Include in handover") is how staff put anything else on the next handover,
 * including after a handover has closed (HZ-018, H-155).
 */
export const HANDOVER_NOTE_TAGS = {
  fall: "fall",
  refusal: "refusal",
  handover: "handover",
} as const;

const MUST_FOLLOW_UPS = [
  "food_and_fluid_record",
  "dietitian_referral",
  "nutrition_assessment",
] as const satisfies readonly CareTaskKind[];

/** Task kinds raised by a MUST result (see raiseCareTriggers and the MUST calculator). */
export const MUST_FOLLOW_UP_TASK_KINDS: readonly `care.${CareTaskKind}`[] = MUST_FOLLOW_UPS.map(
  (kind) => `care.${kind}` as const,
);

/**
 * Whether a chart entry records a refusal: a drink or food refused, or repositioning declined.
 * Mirrors the chart values in `packages/contracts` (`ObservationValues`); other charts have no
 * refusal field. Medicines refusals join from the eMAR in Phase 2 (HZ-003).
 */
export function observationIsRefusal(values: {
  readonly chart: string;
  readonly refused?: boolean;
  readonly declined?: boolean;
}): boolean {
  switch (values.chart) {
    case "fluid_intake":
    case "food":
      return values.refused === true;
    case "repositioning":
      return values.declined === true;
    default:
      return false;
  }
}

/** Entries count for the shift they happened in, and for the shift that received them late. */
interface Timed {
  readonly id: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
}

export interface HandoverTaskSource {
  readonly id: string;
  readonly personId: string | null;
  readonly kind: string;
  /** The task's title, as the round shows it (for the item's summary). */
  readonly title?: string;
  /** Why it was not done or was cancelled, for a skipped task's summary. */
  readonly statusReason?: string | null;
  /** Whether the round is from an earlier plan when the item is compiled (`task.from_earlier_plan`). */
  readonly fromEarlierPlan?: boolean;
  /** The care plan action the round carries out, as the plan words it, when a plan made it. */
  readonly planAction?: string | null;
  readonly status: TaskStatus;
  readonly priority: "routine" | "urgent";
  readonly evidenceRequired: boolean;
  readonly dueAt: Date;
  readonly windowEnd: Date | null;
  readonly createdAt: Date;
  /** When it was done, skipped or cancelled; null while open. */
  readonly closedAt: Date | null;
}

export interface HandoverObservationSource extends Timed {
  readonly personId: string;
  /** The chart (`fluid_intake`, `vital_signs` and so on), for a refusal's summary. */
  readonly chart?: string;
  /** The NEWS2 band for vital signs, null for other charts. */
  readonly news2Band: News2Band | null;
  /** The NEWS2 aggregate score stored with the band, when there is one. */
  readonly news2Score?: number | null;
  /** From `observationIsRefusal`. */
  readonly refused: boolean;
}

export interface HandoverIncidentSource extends Timed {
  readonly personIds: readonly string[];
  readonly type: string;
}

export interface HandoverMarkSource extends Timed {
  readonly personId: string;
  /** What the mark is and where, as the body map stores it, for the item's summary. */
  readonly markType?: string;
  readonly view?: string;
  readonly region?: string;
  readonly side?: string;
}

export interface HandoverNoteSource extends Timed {
  readonly personId: string;
  readonly tags: readonly string[];
}

export interface HandoverAlertSource {
  readonly id: string;
  /** The alert's kind (`care.urgent_result` and so on), for the item's summary. */
  readonly kind?: string;
  /**
   * Why it was raised, when the kind covers more than one reason: the trigger's code for a care
   * result (`news2_threshold`, `iddsi_unsafe_level` and the other IDDSI codes).
   */
  readonly reason?: string;
  /**
   * For a NEWS2 alert, the score and band of the observation that raised it, so the item says
   * what was found, not that it "needs a response now" (#123 clinical review, M6).
   */
  readonly news2?: { readonly score: number; readonly band: string };
  readonly personId: string | null;
  readonly severity: Severity;
  readonly createdAt: Date;
  /** When someone acknowledged it; null while nobody has. */
  readonly acknowledgedAt: Date | null;
}

export interface HandoverSources {
  readonly tasks: readonly HandoverTaskSource[];
  readonly observations: readonly HandoverObservationSource[];
  readonly incidents: readonly HandoverIncidentSource[];
  readonly bodyMapMarks: readonly HandoverMarkSource[];
  readonly notes: readonly HandoverNoteSource[];
  readonly alerts: readonly HandoverAlertSource[];
}

export type HandoverSourceType =
  | "task"
  | "observation"
  | "incident"
  | "body_map_mark"
  | "care_note"
  | "notification";

/**
 * What a handover item says, as a catalogue key and its parameters, so a screen words it in the
 * reader's language without reading the source: the phone holds neither incidents, alerts nor
 * skipped tasks (H-300). Parameters are codes (a NEWS2 band, a chart, an incident type, an alert
 * kind and a care result's reason, a mark's type, view, region and side), the NEWS2 score, and for
 * a task free text staff wrote: its title (up to 120 characters), the care plan action it carries
 * out (the plan's own words) and why it was not done (`status_reason`, up to 500 characters). No
 * field holds a person's name, but free text may mention one, so a summary is shown only to those
 * who may read its sources (ADR-0071, `PERMISSION_PREREQUISITES`).
 */
export interface HandoverItemSummary {
  readonly key: HandoverSummaryKey;
  readonly params: Readonly<Record<string, string | number>>;
}

/** Every summary key, one per kind of item; each app's catalogue words them (`mobile.` + key). */
export const HANDOVER_SUMMARY_KEYS = {
  fall: "handover.summary.fall",
  news2: "handover.summary.news2",
  incident: "handover.summary.incident",
  alert: "handover.summary.alert",
  body_map_mark: "handover.summary.bodyMapMark",
  flagged_note: "handover.summary.flaggedNote",
  overdue_task: "handover.summary.overdueTask",
  skipped_task: "handover.summary.skippedTask",
  unfinished_task: "handover.summary.unfinishedTask",
  must_follow_up: "handover.summary.mustFollowUp",
  refusal: "handover.summary.refusal",
} as const satisfies Record<HandoverItemKind, string>;
export type HandoverSummaryKey = (typeof HANDOVER_SUMMARY_KEYS)[HandoverItemKind];

/** An alert kind as a catalogue choice: `care.urgent_result` becomes `care_urgent_result`. */
export function alertSummaryCode(kind: string | undefined): string {
  return (kind ?? "").replace(/[^a-z0-9_]/gi, "_").toLowerCase() || "other";
}

const summary = (
  kind: HandoverItemKind,
  params: Record<string, string | number> = {},
): HandoverItemSummary => ({ key: HANDOVER_SUMMARY_KEYS[kind], params });

export interface HandoverItem {
  /** Stable identity: the same record never appears twice under the same kind. */
  readonly key: string;
  readonly kind: HandoverItemKind;
  readonly personId: string | null;
  readonly sourceType: HandoverSourceType;
  readonly sourceId: string;
  /** When the event happened (or the task fell due). */
  readonly at: Date;
  /** Appended after the handover was first compiled. */
  readonly lateAddition: boolean;
  readonly addedAt: Date;
  /** What it says (`HandoverItemSummary`); absent on items compiled before summaries existed. */
  readonly summary?: HandoverItemSummary | null;
}

function inShift(at: Date, shift: ShiftWindow): boolean {
  return at.getTime() >= shift.start.getTime() && at.getTime() < shift.end.getTime();
}

function belongs(entry: Timed, shift: ShiftWindow): boolean {
  return inShift(entry.occurredAt, shift) || inShift(entry.recordedAt, shift);
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(TERMINAL_TASK_STATUSES);

/** Every safety-critical item from the shift, in priority order then time. */
export function compileHandover(
  shift: ShiftWindow,
  sources: HandoverSources,
  compiledAt: Date,
): HandoverItem[] {
  const items: HandoverItem[] = [];
  const keys = new Set<string>();
  const add = (
    kind: HandoverItemKind,
    sourceType: HandoverSourceType,
    sourceId: string,
    personId: string | null,
    at: Date,
    params: Record<string, string | number> = {},
  ) => {
    const key = `${kind}:${sourceType}:${sourceId}:${personId ?? "-"}`;
    if (keys.has(key)) return;
    keys.add(key);
    items.push({
      key,
      kind,
      personId,
      sourceType,
      sourceId,
      at,
      lateAddition: false,
      addedAt: compiledAt,
      summary: summary(kind, params),
    });
  };
  // A task's title, the plan action it carries out, and whether it was from an earlier plan when
  // compiled (HZ-024; #50 review round 1, clinical M3).
  const title = (t: HandoverTaskSource) => ({
    title: t.title ?? "",
    planAction: t.planAction ?? "",
    earlierPlan: t.fromEarlierPlan ? "yes" : "no",
  });
  const end = shift.end.getTime();

  for (const o of sources.observations) {
    if (!belongs(o, shift)) continue;
    // Anything above "low" asks for more than routine monitoring: an aggregate of 5 or more, or a
    // single parameter scoring 3 (RCP NEWS2, 2017).
    if (o.news2Band && o.news2Band !== "low") {
      const score = o.news2Score;
      add("news2", "observation", o.id, o.personId, o.occurredAt, {
        band: o.news2Band,
        ...(typeof score === "number" ? { scored: "yes", score } : { scored: "no" }),
      });
    }
    if (o.refused) {
      add("refusal", "observation", o.id, o.personId, o.occurredAt, {
        source: "observation",
        chart: o.chart ?? "other",
      });
    }
  }
  for (const incident of sources.incidents) {
    if (!belongs(incident, shift)) continue;
    const kind = incident.type === "fall" ? "fall" : "incident";
    const people = incident.personIds.length > 0 ? incident.personIds : [null];
    const params: Record<string, string> =
      kind === "fall" ? { source: "incident" } : { type: incident.type };
    for (const personId of people)
      add(kind, "incident", incident.id, personId, incident.occurredAt, params);
  }
  for (const mark of sources.bodyMapMarks) {
    if (belongs(mark, shift)) {
      add("body_map_mark", "body_map_mark", mark.id, mark.personId, mark.occurredAt, {
        markType: mark.markType ?? "other",
        view: mark.view ?? "",
        region: mark.region ?? "",
        side: mark.side ?? "",
      });
    }
  }
  for (const note of sources.notes) {
    if (!belongs(note, shift)) continue;
    if (note.tags.includes(HANDOVER_NOTE_TAGS.fall))
      add("fall", "care_note", note.id, note.personId, note.occurredAt, { source: "care_note" });
    if (note.tags.includes(HANDOVER_NOTE_TAGS.refusal)) {
      add("refusal", "care_note", note.id, note.personId, note.occurredAt, {
        source: "care_note",
        chart: "other",
      });
    }
    if (note.tags.includes(HANDOVER_NOTE_TAGS.handover)) {
      add("flagged_note", "care_note", note.id, note.personId, note.occurredAt);
    }
  }
  for (const alert of sources.alerts) {
    if (alert.severity !== "urgent" || alert.createdAt.getTime() >= end) continue;
    // Raised this shift, or raised earlier and still unacknowledged when the shift ended.
    const unacknowledged = alert.acknowledgedAt === null || alert.acknowledgedAt.getTime() >= end;
    if (inShift(alert.createdAt, shift) || unacknowledged) {
      add("alert", "notification", alert.id, alert.personId, alert.createdAt, {
        // What it is about, never whether anyone has acknowledged it: an item is compiled mid-shift
        // and never changes, so that would soon be untrue (#50 review round 1, clinical M1).
        alert: alertSummaryCode(alert.kind),
        reason: alertSummaryCode(alert.reason),
        // The score and band found, as published, never "needs a response now", which an item
        // compiled once would keep saying (#123 clinical review, M6).
        ...(alert.news2
          ? { scored: "yes", score: alert.news2.score, band: alert.news2.band }
          : { scored: "no" }),
      });
    }
  }
  for (const t of sources.tasks) {
    if (TERMINAL.has(t.status)) {
      // An urgent or evidence-bearing task skipped or cancelled this shift (with its reason).
      const notDone = t.status === "skipped" || t.status === "cancelled";
      if (
        notDone &&
        t.closedAt &&
        inShift(t.closedAt, shift) &&
        (t.priority === "urgent" || t.evidenceRequired)
      ) {
        add("skipped_task", "task", t.id, t.personId, t.closedAt, {
          ...title(t),
          status: t.status,
          reason: t.statusReason ?? "",
        });
      }
      continue;
    }
    const windowEnd = (t.windowEnd ?? t.dueAt).getTime();
    if (windowEnd < end) {
      add("overdue_task", "task", t.id, t.personId, t.windowEnd ?? t.dueAt, title(t));
    } else if (t.dueAt.getTime() < end) {
      // Due by the end of the shift and not done, though its window is still open.
      add("unfinished_task", "task", t.id, t.personId, t.dueAt, title(t));
    }
    // Raised this shift; an older one still open shows as overdue once its window closes.
    if (
      (MUST_FOLLOW_UP_TASK_KINDS as readonly string[]).includes(t.kind) &&
      inShift(t.createdAt, shift)
    ) {
      add("must_follow_up", "task", t.id, t.personId, t.createdAt, title(t));
    }
  }

  const rank = (k: HandoverItemKind) => HANDOVER_ITEM_KINDS.indexOf(k);
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || a.at.getTime() - b.at.getTime());
}

/**
 * Recompiles after late syncs: every existing item stays, whatever has happened to its source
 * since, and new items are appended as late additions. The API refreshes both the handover of the
 * shift an entry happened in and the one of the shift that received it, including locked ones.
 */
export function refreshHandover(
  existing: readonly HandoverItem[],
  shift: ShiftWindow,
  sources: HandoverSources,
  now: Date,
): { readonly items: HandoverItem[]; readonly added: HandoverItem[] } {
  const known = new Set(existing.map((i) => i.key));
  const added = compileHandover(shift, sources, now)
    .filter((i) => !known.has(i.key))
    .map((i) => ({ ...i, lateAddition: true, addedAt: now }));
  return { items: [...existing, ...added], added };
}

/** Refuses an update that would drop a compiled item (items are only ever added to). */
export function checkHandoverKeepsItems(
  before: readonly HandoverItem[],
  afterKeys: readonly string[],
):
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly string[]; readonly message: string } {
  const after = new Set(afterKeys);
  const missing = before.map((i) => i.key).filter((k) => !after.has(k));
  return missing.length === 0
    ? { ok: true }
    : {
        ok: false,
        missing,
        message: "Handover items cannot be removed. Add a note to an item instead.",
      };
}

// ------------------------------------------------------------------------------------------------
// Acknowledgement (COMMS-006)
// ------------------------------------------------------------------------------------------------

export interface HandoverAcknowledgement {
  readonly tenantUserId: string;
  /** Server time. */
  readonly at: Date;
  /**
   * The keys of the items the person could see when they acknowledged, recorded by the server
   * (never sent by the device), so an acknowledgement covers exactly what was in front of them.
   */
  readonly itemKeys: readonly string[];
}

/** The keys a member of staff has acknowledged, over their acknowledgements (from `since`). */
function keysSeenBy(
  acknowledgements: readonly HandoverAcknowledgement[],
  tenantUserId: string,
  since?: Date,
): Set<string> {
  const seen = new Set<string>();
  for (const a of acknowledgements) {
    if (a.tenantUserId !== tenantUserId) continue;
    if (since && a.at.getTime() < since.getTime()) continue;
    for (const key of a.itemKeys) seen.add(key);
  }
  return seen;
}

/**
 * Who has acknowledged the handover as it stands, and for everyone else the items they have not
 * yet seen: all of them, or only the late additions since their last acknowledgement, so a
 * second acknowledgement is about the new items rather than a click through the whole list.
 */
export function acknowledgementState(
  items: readonly HandoverItem[],
  incomingStaff: readonly string[],
  acknowledgements: readonly HandoverAcknowledgement[],
): {
  readonly acknowledged: string[];
  readonly pending: string[];
  readonly complete: boolean;
  readonly unseen: ReadonlyMap<string, readonly HandoverItem[]>;
} {
  const staff = [...new Set(incomingStaff)];
  const unseen = new Map<string, readonly HandoverItem[]>();
  for (const id of staff) {
    const acknowledgedOnce = acknowledgements.some((a) => a.tenantUserId === id);
    const seen = keysSeenBy(acknowledgements, id);
    const outstanding = items.filter((i) => !seen.has(i.key));
    if (!acknowledgedOnce || outstanding.length > 0) unseen.set(id, outstanding);
  }
  const pending = staff.filter((id) => unseen.has(id));
  const acknowledged = staff.filter((id) => !unseen.has(id));
  return { acknowledged, pending, complete: staff.length > 0 && pending.length === 0, unseen };
}

// ------------------------------------------------------------------------------------------------
// Slice 5: the stored handover (care.md rule 8 as built in slice 5)
// ------------------------------------------------------------------------------------------------

/** The shift before this one: the handover compiled when this shift starts. */
export function previousShift(shift: ShiftWindow, pattern: ShiftPattern): ShiftWindow {
  return shiftAt(new Date(shift.start.getTime() - 1), pattern);
}

/**
 * Whether the outgoing staff may still add notes: until the shift ends or the handover is locked,
 * whichever comes first. Late additions and acknowledgements continue after that.
 */
export function handoverOpen(shift: ShiftWindow, lockedAt: Date | null, now: Date): boolean {
  return lockedAt === null && now.getTime() < shift.end.getTime();
}

/** The notice that a handover has late additions; never itself an item of a handover. */
export const HANDOVER_NOTIFICATION_KIND = "care.handover.updated";
/** Every notice about a handover starts with this; none is ever an item of a handover. */
export const HANDOVER_NOTICE_KIND_PREFIX = "care.handover.";

/** One notification row as stored: each recipient has their own copy. */
export interface AlertNotification {
  readonly id: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly personId: string | null;
  readonly createdAt: Date;
  readonly acknowledgedAt: Date | null;
  /** Why it was raised, when the source says (`HandoverAlertSource.reason`). */
  readonly reason?: string;
  /** For a NEWS2 alert, the observation's score and band (`HandoverAlertSource.news2`). */
  readonly news2?: { readonly score: number; readonly band: string };
}

/**
 * The urgent alert kinds a handover item's summary words by name (#50 review round 1, clinical M2);
 * any other is worded as "see the alert". Each has a catalogue entry (a test checks), and a care
 * result is worded by its trigger's code (`ALERT_REASON_CODES`).
 */
export const HANDOVER_ALERT_KINDS = [
  "care.urgent_result",
  "safety.notification.overdue",
  "care.refused_entry_urgent",
  "sync.revoked_device_waiting",
  "platform.task.overdue",
  "care.dols.expiring",
] as const;

/** The trigger codes a care result's alert may carry (`UrgentAlertCode`). */
export const ALERT_REASON_CODES = [
  "news2_threshold",
  "iddsi_level_not_recorded",
  "iddsi_reason_missing",
  "iddsi_prescribed_unreadable",
  "iddsi_unsafe_level",
] as const;

/** NEWS2 bands as stored on an observation's flags (`news2.band`). */
const NEWS2_BANDS: ReadonlySet<string> = new Set(["low", "low_medium", "medium", "high"]);

/** The NEWS2 score and band an observation's flags hold, when both are readable. */
export function alertNews2FromFlags(
  flags: unknown,
): { readonly score: number; readonly band: string } | undefined {
  if (typeof flags !== "object" || flags === null) return undefined;
  const news2 = (flags as { news2?: unknown }).news2;
  if (typeof news2 !== "object" || news2 === null) return undefined;
  const { score, band } = news2 as { score?: unknown; band?: unknown };
  return typeof score === "number" &&
    Number.isInteger(score) &&
    typeof band === "string" &&
    NEWS2_BANDS.has(band)
    ? { score, band }
    : undefined;
}

/**
 * The trigger code of a care result from its observation's stored flags: an IDDSI alert by its
 * problem, otherwise a NEWS2 threshold; undefined when the flags say neither.
 */
export function alertReasonFromFlags(flags: unknown): string | undefined {
  if (typeof flags !== "object" || flags === null) return undefined;
  const f = flags as { iddsiAlert?: unknown; iddsiProblem?: unknown; news2?: unknown };
  if (f.iddsiAlert === true) {
    return typeof f.iddsiProblem === "string" ? `iddsi_${f.iddsiProblem}` : "iddsi_unsafe_level";
  }
  return f.news2 ? "news2_threshold" : undefined;
}

/**
 * The alerts a handover reads: one per condition (the same kind about the same record), however
 * many people it reached (HZ-008), identified by its first copy so it keeps its key from one
 * compilation to the next. It counts as acknowledged from the first time anyone acknowledged it.
 * Escalation copies (re-sent to the next people in a chain) belong to the alert they escalate, and
 * the handover's own notices are never an item of a handover.
 */
export function alertConditions(rows: readonly AlertNotification[]): HandoverAlertSource[] {
  const groups = new Map<string, AlertNotification[]>();
  for (const row of rows) {
    if (row.sourceType === "notification" || row.kind.startsWith(HANDOVER_NOTICE_KIND_PREFIX)) {
      continue;
    }
    const key =
      row.sourceType && row.sourceId
        ? `${row.kind}:${row.sourceType}:${row.sourceId}`
        : `own:${row.id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const alerts: HandoverAlertSource[] = [];
  for (const copies of groups.values()) {
    const sorted = [...copies].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const first = sorted[0] as AlertNotification;
    const acknowledged = copies
      .map((c) => c.acknowledgedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    const reason = copies.find((c) => c.reason)?.reason;
    const news2 = copies.find((c) => c.news2)?.news2;
    alerts.push({
      id: first.id,
      kind: first.kind,
      ...(reason ? { reason } : {}),
      ...(news2 ? { news2 } : {}),
      personId: copies.find((c) => c.personId !== null)?.personId ?? null,
      severity: copies.some((c) => c.severity === "urgent") ? "urgent" : first.severity,
      createdAt: first.createdAt,
      acknowledgedAt: acknowledged[0] ?? null,
    });
  }
  return alerts.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

/**
 * Where one member of staff stands with a handover, over the items they can see: items about
 * people outside their scope are never shown to them (HZ-011), and late additions about those
 * people do not ask them to acknowledge again. Every acknowledgement they made counts, by the keys
 * the server recorded; never anyone else's.
 */
export function viewerAcknowledgement(
  items: readonly HandoverItem[],
  isVisible: (item: HandoverItem) => boolean,
  acknowledgements: readonly HandoverAcknowledgement[],
  tenantUserId: string,
): {
  readonly acknowledged: boolean;
  readonly acknowledgedAt: Date | null;
  readonly seenKeys: ReadonlySet<string>;
  readonly unseen: readonly HandoverItem[];
} {
  const own = acknowledgements.filter((a) => a.tenantUserId === tenantUserId);
  const seenKeys = keysSeenBy(own, tenantUserId);
  const unseen = items.filter((i) => isVisible(i) && !seenKeys.has(i.key));
  const last = own.map((a) => a.at.getTime()).sort((a, b) => b - a)[0];
  return {
    acknowledged: own.length > 0 && unseen.length === 0,
    acknowledgedAt: last === undefined ? null : new Date(last),
    seenKeys,
    unseen,
  };
}

/**
 * Whether the incoming shift has acknowledged the handover (COMMS-006; HZ-018, H-153): there is at
 * least one acknowledgement made at or after the end of the shift it hands over, and every item is
 * covered by one of them. Coverage comes from the keys each acknowledgement recorded (what its
 * author could see then), never from who can see what now, so access that ends later does not undo
 * it; an acknowledgement made before the shift ended (the outgoing staff reading it back) never
 * counts, and an item added since nobody on the incoming shift has acknowledged leaves it open.
 */
export function incomingAcknowledged(
  shift: ShiftWindow,
  items: readonly HandoverItem[],
  acknowledgements: readonly HandoverAcknowledgement[],
): boolean {
  const incoming = acknowledgements.filter((a) => a.at.getTime() >= shift.end.getTime());
  if (incoming.length === 0) return false;
  const covered = new Set(incoming.flatMap((a) => a.itemKeys));
  return items.every((i) => covered.has(i.key));
}

/** The alert to the nurse in charge that nobody on the incoming shift has acknowledged. */
export const HANDOVER_UNACKNOWLEDGED_KIND = "care.handover.unacknowledged";
/** The worker raises the alert once, within this many hours of it falling due; never after. */
export const UNACKNOWLEDGED_ALERT_WINDOW_HOURS = 24;

/**
 * Whether the nurse in charge should now be told that a handover is unacknowledged (H-153):
 * from the rate table's grace period after the shift ends, while nobody on the incoming shift has
 * acknowledged it (`incomingAcknowledged`), for one day; each nurse in charge is told once.
 */
export function unacknowledgedAlertDue(input: {
  readonly shift: ShiftWindow;
  readonly now: Date;
  readonly graceMinutes: number;
  readonly acknowledged: boolean;
}): boolean {
  if (input.acknowledged) return false;
  const due = input.shift.end.getTime() + input.graceMinutes * 60_000;
  const now = input.now.getTime();
  return now >= due && now < due + UNACKNOWLEDGED_ALERT_WINDOW_HOURS * 3_600_000;
}

export type HandoverCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export const MAX_HANDOVER_NOTE_LENGTH = 2000;

/**
 * Why a closed handover takes no more notes, and how to reach the next one: a care note tagged
 * "Include in handover" (`HANDOVER_NOTE_TAGS.handover`) is compiled into the handover of the shift
 * it is recorded in (the next one), and into this one as a late addition if it is timed within
 * this shift (HZ-018).
 */
export const HANDOVER_CLOSED_MESSAGE =
  'This handover has closed. Add a care note tagged "Include in handover" instead: the next handover carries it, and if you time it within this shift it is added to this handover too.';

/**
 * A note the outgoing staff add, on the handover or on one of its items, while it is open. Notes
 * add to items; they never replace or remove one.
 */
export function checkHandoverNote(input: {
  readonly open: boolean;
  readonly body: string;
  readonly itemKey: string | null;
  readonly itemKeys: readonly string[];
}): HandoverCheck {
  if (!input.open) {
    return {
      ok: false,
      message: HANDOVER_CLOSED_MESSAGE,
    };
  }
  const body = input.body.trim();
  if (body.length === 0) return { ok: false, message: "Write the note before saving it." };
  if (body.length > MAX_HANDOVER_NOTE_LENGTH) {
    return {
      ok: false,
      message: `Keep a note to ${MAX_HANDOVER_NOTE_LENGTH} characters, or add a second note.`,
    };
  }
  if (input.itemKey !== null && !input.itemKeys.includes(input.itemKey)) {
    return { ok: false, message: "That item is not on this handover." };
  }
  return { ok: true };
}

/** Item kinds whose late addition interrupts (push as well as in the app): they cannot wait. */
export const URGENT_LATE_ADDITION_KINDS: readonly HandoverItemKind[] = [
  "fall",
  "news2",
  "incident",
  "alert",
];

/**
 * How loudly a late addition is announced (HZ-008 tiering): urgent when it adds a fall, a raised
 * NEWS2, an incident or an urgent alert; a warning in the app for anything else; nothing when
 * nothing was added.
 */
export function lateAdditionSeverity(added: readonly HandoverItem[]): "urgent" | "warning" | null {
  if (added.length === 0) return null;
  return added.some((i) => URGENT_LATE_ADDITION_KINDS.includes(i.kind)) ? "urgent" : "warning";
}

/** One notice about a late addition: who, how loudly, and the added items it is about. */
export interface LateAdditionNotice {
  readonly recipient: string;
  readonly severity: "urgent" | "warning";
  /** Only items the recipient can see; the notice itself names none of them. */
  readonly items: readonly HandoverItem[];
}

/**
 * Who hears about items added to a handover after it was compiled, and how loudly (care.md rule 8;
 * HZ-018, HZ-008, HZ-011). Nothing is sent before the receiving shift starts: until then the
 * additions are simply part of the handover the incoming staff will read. While the receiving
 * shift runs, each member of staff who acknowledged it on that shift (at or after its start; an
 * outgoing read-back never counts) hears about the additions they can see; the nurse in charge on
 * duty hears about any addition none of them can see (all of them when nobody has) and always about
 * a fall, a raised NEWS2, an incident or an urgent alert. Once the receiving shift has ended, the
 * nurse in charge hears about everything added. Nobody hears about, or is interrupted by, an item
 * they cannot see; an item nobody can see is returned as `unheard`, for the record.
 */
export function lateAdditionNotices(input: {
  readonly receivingShift: ShiftWindow;
  readonly now: Date;
  readonly added: readonly HandoverItem[];
  readonly acknowledgements: readonly { readonly tenantUserId: string; readonly at: Date }[];
  readonly nurseInCharge: readonly string[];
  readonly canSee: (tenantUserId: string, item: HandoverItem) => boolean;
}): { readonly notices: LateAdditionNotice[]; readonly unheard: HandoverItem[] } {
  const { added, canSee, receivingShift } = input;
  const now = input.now.getTime();
  if (added.length === 0 || now < receivingShift.start.getTime()) {
    return { notices: [], unheard: [] };
  }
  const running = now < receivingShift.end.getTime();
  const incoming = input.acknowledgements
    .filter((a) => a.at.getTime() >= receivingShift.start.getTime())
    .map((a) => a.tenantUserId);
  const staff = running ? [...new Set(incoming)] : [];
  const told = new Map<string, Set<string>>();
  const tell = (recipient: string, items: readonly HandoverItem[]) => {
    const keys = told.get(recipient) ?? new Set<string>();
    for (const i of items) if (canSee(recipient, i)) keys.add(i.key);
    told.set(recipient, keys);
  };
  for (const id of staff) tell(id, added);
  const forNurse = running
    ? added.filter(
        (i) => URGENT_LATE_ADDITION_KINDS.includes(i.kind) || !staff.some((id) => canSee(id, i)),
      )
    : added;
  for (const id of new Set(input.nurseInCharge)) tell(id, forNurse);
  const notices: LateAdditionNotice[] = [];
  const heard = new Set<string>();
  for (const [recipient, keys] of told) {
    const items = added.filter((i) => keys.has(i.key));
    const severity = lateAdditionSeverity(items);
    if (!severity) continue;
    for (const i of items) heard.add(i.key);
    notices.push({ recipient, severity, items });
  }
  return { notices, unheard: added.filter((i) => !heard.has(i.key)) };
}
