import type { TaskStatus } from "../platform/tasks";
import { TERMINAL_TASK_STATUSES } from "../platform/tasks";
import { fromUkWallClock, toUkWallClock } from "../shared/time";
import type { News2Band } from "./news2";

/**
 * Shift handover (care.md rule 8, hazard HZ-018). The handover compiles itself from the shift's
 * records by rule, so it never depends on memory: falls, NEWS2 results that ask for more than
 * routine monitoring, incidents, new body-map marks, refusals, tasks still overdue at the end of
 * the shift, open MUST follow-ups and urgent alerts. Compiled items can be annotated but never
 * removed; items that sync after compilation are appended as late additions, and anyone who
 * acknowledged before them must acknowledge again.
 */

// ------------------------------------------------------------------------------------------------
// Shifts
// ------------------------------------------------------------------------------------------------

/** Rate-table keys for the shift pattern (tenant defaults until rotas define shifts). */
export const HANDOVER_RATE_KEYS = {
  dayShiftStartHour: "handover.day_shift_start_hour",
  nightShiftStartHour: "handover.night_shift_start_hour",
} as const;

/** Start hours in UK local time, from the rate table (`HANDOVER_RATE_KEYS`). */
export interface ShiftPattern {
  readonly dayStartHour: number;
  readonly nightStartHour: number;
}

export interface ShiftWindow {
  readonly kind: "day" | "night";
  readonly start: Date;
  /** Exclusive. A night shift over a clock change is an hour shorter or longer. */
  readonly end: Date;
}

export class ShiftPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShiftPatternError";
  }
}

function checkPattern(pattern: ShiftPattern): void {
  const { dayStartHour: day, nightStartHour: night } = pattern;
  if (!Number.isInteger(day) || !Number.isInteger(night) || day < 0 || night > 23 || day >= night) {
    throw new ShiftPatternError(
      "The day shift must start on the hour before the night shift, both between 00:00 and 23:00.",
    );
  }
}

function ukDayStart(year: number, month: number, day: number, hour: number): Date {
  const d = new Date(Date.UTC(year, month - 1, day));
  return fromUkWallClock(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, 0);
}

/** The shift running at an instant, in UK local time. */
export function shiftAt(instant: Date, pattern: ShiftPattern): ShiftWindow {
  checkPattern(pattern);
  const w = toUkWallClock(instant);
  const at = (dayOffset: number, hour: number) =>
    ukDayStart(w.year, w.month, w.day + dayOffset, hour);
  if (w.hour >= pattern.dayStartHour && w.hour < pattern.nightStartHour) {
    return { kind: "day", start: at(0, pattern.dayStartHour), end: at(0, pattern.nightStartHour) };
  }
  if (w.hour >= pattern.nightStartHour) {
    return {
      kind: "night",
      start: at(0, pattern.nightStartHour),
      end: at(1, pattern.dayStartHour),
    };
  }
  return { kind: "night", start: at(-1, pattern.nightStartHour), end: at(0, pattern.dayStartHour) };
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
  "must_follow_up",
  "refusal",
] as const;
export type HandoverItemKind = (typeof HANDOVER_ITEM_KINDS)[number];

/** Note tags that put a note on the handover. */
export const HANDOVER_NOTE_TAGS = { fall: "fall", refusal: "refusal" } as const;

/** Task kinds raised by a MUST result (see raiseCareTriggers and the MUST calculator). */
export const MUST_FOLLOW_UP_TASK_KINDS: readonly string[] = [
  "care.food_and_fluid_record",
  "care.dietitian_referral",
  "care.nutrition_assessment",
];

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
  readonly dueAt: Date;
  readonly windowEnd: Date | null;
  readonly createdAt: Date;
}

export interface HandoverObservationSource extends Timed {
  readonly personId: string;
  /** The NEWS2 band for vital signs, null for other charts. */
  readonly news2Band: News2Band | null;
  /** Food or drink refused, or repositioning declined. */
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
  readonly severity: string;
  readonly createdAt: Date;
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
  /** Stable identity: the same record never appears twice. */
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
  const add = (
    kind: HandoverItemKind,
    sourceType: HandoverSourceType,
    sourceId: string,
    personId: string | null,
    at: Date,
  ) => {
    const key = `${kind}:${sourceType}:${sourceId}:${personId ?? "-"}`;
    if (items.some((i) => i.key === key)) return;
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

  for (const o of sources.observations) {
    if (!belongs(o, shift)) continue;
    // Anything above "low" asks for more than routine monitoring, including a single parameter
    // scoring 3 (RCP NEWS2, 2017).
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
    if (alert.severity === "urgent" && inShift(alert.createdAt, shift)) {
      add("alert", "notification", alert.id, alert.personId, alert.createdAt);
    }
  }
  for (const t of sources.tasks) {
    if (TERMINAL.has(t.status)) continue;
    const end = t.windowEnd ?? t.dueAt;
    if (end.getTime() < shift.end.getTime()) add("overdue_task", "task", t.id, t.personId, end);
    // Raised this shift; an older one still open shows as overdue once its window closes.
    if (MUST_FOLLOW_UP_TASK_KINDS.includes(t.kind) && inShift(t.createdAt, shift)) {
      add("must_follow_up", "task", t.id, t.personId, t.createdAt);
    }
  }

  const rank = (k: HandoverItemKind) => HANDOVER_ITEM_KINDS.indexOf(k);
  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || a.at.getTime() - b.at.getTime());
}

/**
 * Recompiles after late syncs: every existing item stays, whatever has happened to its source
 * since, and new items are appended as late additions.
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
  readonly at: Date;
}

/**
 * Who has acknowledged the handover as it stands. An acknowledgement made before the latest late
 * addition no longer counts: that person has not seen everything yet.
 */
export function acknowledgementState(
  items: readonly HandoverItem[],
  incomingStaff: readonly string[],
  acknowledgements: readonly HandoverAcknowledgement[],
): { readonly acknowledged: string[]; readonly pending: string[]; readonly complete: boolean } {
  const latest = Math.max(0, ...items.map((i) => i.addedAt.getTime()));
  const current = new Set(
    acknowledgements.filter((a) => a.at.getTime() >= latest).map((a) => a.tenantUserId),
  );
  const staff = [...new Set(incomingStaff)];
  const acknowledged = staff.filter((id) => current.has(id));
  const pending = staff.filter((id) => !current.has(id));
  return { acknowledged, pending, complete: staff.length > 0 && pending.length === 0 };
}
