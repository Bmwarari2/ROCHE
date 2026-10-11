import type { Severity } from "../platform/notifications";
import type { TaskStatus } from "../platform/tasks";
import { TERMINAL_TASK_STATUSES } from "../platform/tasks";
import { fromUkWallClock, toUkWallClock } from "../shared/time";
import type { CareTaskKind } from "./assessment";
import type { News2Band } from "./news2";

/**
 * Shift handover (care.md rule 8, hazard HZ-018). The handover compiles itself from the shift's
 * records by rule, so it never depends on memory: falls, NEWS2 results that ask for more than
 * routine monitoring, incidents, urgent alerts nobody has acknowledged, new body-map marks, tasks
 * overdue, skipped or unfinished at the end of the shift, MUST follow-ups and refusals. Compiled
 * items can be annotated but never removed; items that sync after compilation are appended as late
 * additions, and anyone who acknowledged before them must acknowledge the new items too.
 */

// ------------------------------------------------------------------------------------------------
// Shifts
// ------------------------------------------------------------------------------------------------

/** Rate-table keys for the default two-shift pattern (until rotas define shifts per location). */
export const HANDOVER_RATE_KEYS = {
  dayShiftStartMinute: "handover.day_shift_start_minute",
  nightShiftStartMinute: "handover.night_shift_start_minute",
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
 */
export const HANDOVER_NOTE_TAGS = { fall: "fall", refusal: "refusal" } as const;

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
  /** The NEWS2 band for vital signs, null for other charts. */
  readonly news2Band: News2Band | null;
  /** From `observationIsRefusal`. */
  readonly refused: boolean;
}

export interface HandoverIncidentSource extends Timed {
  readonly personIds: readonly string[];
  readonly type: string;
}

export interface HandoverMarkSource extends Timed {
  readonly personId: string;
}

export interface HandoverNoteSource extends Timed {
  readonly personId: string;
  readonly tags: readonly string[];
}

export interface HandoverAlertSource {
  readonly id: string;
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
    });
  };
  const end = shift.end.getTime();

  for (const o of sources.observations) {
    if (!belongs(o, shift)) continue;
    // Anything above "low" asks for more than routine monitoring: an aggregate of 5 or more, or a
    // single parameter scoring 3 (RCP NEWS2, 2017).
    if (o.news2Band && o.news2Band !== "low")
      add("news2", "observation", o.id, o.personId, o.occurredAt);
    if (o.refused) add("refusal", "observation", o.id, o.personId, o.occurredAt);
  }
  for (const incident of sources.incidents) {
    if (!belongs(incident, shift)) continue;
    const kind = incident.type === "fall" ? "fall" : "incident";
    const people = incident.personIds.length > 0 ? incident.personIds : [null];
    for (const personId of people)
      add(kind, "incident", incident.id, personId, incident.occurredAt);
  }
  for (const mark of sources.bodyMapMarks) {
    if (belongs(mark, shift))
      add("body_map_mark", "body_map_mark", mark.id, mark.personId, mark.occurredAt);
  }
  for (const note of sources.notes) {
    if (!belongs(note, shift)) continue;
    if (note.tags.includes(HANDOVER_NOTE_TAGS.fall))
      add("fall", "care_note", note.id, note.personId, note.occurredAt);
    if (note.tags.includes(HANDOVER_NOTE_TAGS.refusal)) {
      add("refusal", "care_note", note.id, note.personId, note.occurredAt);
    }
  }
  for (const alert of sources.alerts) {
    if (alert.severity !== "urgent" || alert.createdAt.getTime() >= end) continue;
    // Raised this shift, or raised earlier and still unacknowledged when the shift ended.
    const unacknowledged = alert.acknowledgedAt === null || alert.acknowledgedAt.getTime() >= end;
    if (inShift(alert.createdAt, shift) || unacknowledged) {
      add("alert", "notification", alert.id, alert.personId, alert.createdAt);
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
        add("skipped_task", "task", t.id, t.personId, t.closedAt);
      }
      continue;
    }
    const windowEnd = (t.windowEnd ?? t.dueAt).getTime();
    if (windowEnd < end) {
      add("overdue_task", "task", t.id, t.personId, t.windowEnd ?? t.dueAt);
    } else if (t.dueAt.getTime() < end) {
      // Due by the end of the shift and not done, though its window is still open.
      add("unfinished_task", "task", t.id, t.personId, t.dueAt);
    }
    // Raised this shift; an older one still open shows as overdue once its window closes.
    if (
      (MUST_FOLLOW_UP_TASK_KINDS as readonly string[]).includes(t.kind) &&
      inShift(t.createdAt, shift)
    ) {
      add("must_follow_up", "task", t.id, t.personId, t.createdAt);
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

/**
 * Who hears about a late addition: the incoming staff while their shift runs, otherwise the nurse
 * in charge on duty now, never staff who have gone home.
 */
export function lateAdditionRecipients(
  receivingShift: ShiftWindow,
  now: Date,
  incomingStaff: readonly string[],
  nurseInChargeOnDuty: readonly string[],
): { readonly to: "incoming_staff" | "nurse_in_charge"; readonly recipients: readonly string[] } {
  return now.getTime() < receivingShift.end.getTime()
    ? { to: "incoming_staff", recipients: [...new Set(incomingStaff)] }
    : { to: "nurse_in_charge", recipients: [...new Set(nurseInChargeOnDuty)] };
}

// ------------------------------------------------------------------------------------------------
// Acknowledgement (COMMS-006)
// ------------------------------------------------------------------------------------------------

export interface HandoverAcknowledgement {
  readonly tenantUserId: string;
  /** Server time. */
  readonly at: Date;
  /**
   * How many items the handover held when this person acknowledged it. Items are only ever
   * appended, so the count is the version they saw; no clock comparison is involved.
   */
  readonly itemsSeen: number;
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
  const seen = new Map<string, number>();
  for (const a of acknowledgements) {
    seen.set(a.tenantUserId, Math.max(seen.get(a.tenantUserId) ?? 0, a.itemsSeen));
  }
  const staff = [...new Set(incomingStaff)];
  const unseen = new Map<string, readonly HandoverItem[]>();
  for (const id of staff) {
    const count = seen.get(id);
    const outstanding = count === undefined ? items : items.slice(count);
    if (count === undefined || outstanding.length > 0) unseen.set(id, outstanding);
  }
  const pending = staff.filter((id) => unseen.has(id));
  const acknowledged = staff.filter((id) => !unseen.has(id));
  return { acknowledged, pending, complete: staff.length > 0 && pending.length === 0, unseen };
}
