/**
 * The member's own shifts and clock on the phone (scheduling.md section 18; SCHED-002, SCHED-004),
 * worked out from the synced rows and what the phone has queued, so the screen only draws. Pure
 * apart from the translator.
 *
 * The phone never decides whether a clock-in is allowed: the API applies the rule on the day
 * (HZ-124) when the event arrives, and a refusal comes back in its own words ("needs attention").
 * The phone only offers what makes sense from the member's own events: clock in when not clocked
 * in, a break or clock out when in, end the break when on one.
 */
import { parseInstant, ukDateTimeParts } from "../care/time";
import { type MessageKey, t } from "../i18n/t";

export interface ShiftRow {
  readonly id: string;
  readonly location_id: string | null;
  readonly label: string | null;
  readonly kind: string | null;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly break_minutes: number | null;
  readonly changed_after_publish_at: string | null;
}

export interface ClockEventRow {
  readonly id: string;
  readonly kind: string | null;
  readonly shift_id: string | null;
  readonly location_id: string | null;
  readonly device_time: string | null;
  /** The server's time; empty until the event has reached the server. */
  readonly recorded_at: string | null;
}

export type ClockState = "out" | "in" | "on_break";
export type ClockKind = "in" | "out" | "break_start" | "break_end";

export interface ShiftItem {
  readonly id: string;
  readonly locationId: string | null;
  readonly title: string;
  /** "31/10/2026, 07:00 to 15:00", in UK time. */
  readonly when: string;
  readonly kindWords: string;
  /** Words when the shift changed after it was published, else null. */
  readonly changed: string | null;
  readonly now: boolean;
}

export interface ClockAction {
  readonly kind: ClockKind;
  readonly label: string;
  /** What a screen reader says: the action and the shift it is for. */
  readonly accessibilityLabel: string;
}

export interface ClockView {
  readonly state: ClockState;
  /** "Not clocked in", "Clocked in at 07:02", "On a break since 10:15". */
  readonly words: string;
  /** Events made on this phone that have not reached Harbour yet. */
  readonly waiting: number;
  readonly actions: readonly ClockAction[];
  /** The shift a clock-in is for: the one under way, or the next to start soon. */
  readonly shift: ShiftItem | null;
  /**
   * Where and for which shift the next event is: a clock-in takes the shift's; a break or clock-out
   * the clock-in's own, so the day's events stay together. Null location: the phone cannot tell.
   */
  readonly locationId: string | null;
  readonly shiftId: string | null;
  readonly shifts: readonly ShiftItem[];
}

/**
 * How early before a shift's start the phone offers to clock in for it. A product setting, not a
 * statutory figure: the API applies the organisation's own rules to whatever arrives.
 */
export const CLOCK_IN_EARLY_MINUTES = 60;

const KIND_WORDS: Record<string, MessageKey> = {
  work: "mobile.shifts.kind.work",
  sleep_in: "mobile.shifts.kind.sleep_in",
  on_call_at_workplace: "mobile.shifts.kind.on_call_at_workplace",
  on_call_away: "mobile.shifts.kind.on_call_away",
  training: "mobile.shifts.kind.training",
};

function time(instant: Date): string {
  return ukDateTimeParts(instant).time;
}

function shiftItem(row: ShiftRow, now: Date): ShiftItem | null {
  const start = parseInstant(row.starts_at);
  const end = parseInstant(row.ends_at);
  if (!start || !end) return null;
  const startParts = ukDateTimeParts(start);
  return {
    id: row.id,
    locationId: row.location_id,
    title: row.label?.trim() || t("mobile.shifts.untitled"),
    when: t("mobile.shifts.when", {
      date: startParts.date,
      start: startParts.time,
      end: time(end),
    }),
    kindWords: t(KIND_WORDS[row.kind ?? ""] ?? "mobile.shifts.kind.work"),
    changed: row.changed_after_publish_at ? t("mobile.shifts.changed") : null,
    now: start.getTime() <= now.getTime() && now.getTime() < end.getTime(),
  };
}

/** The member's shifts that have not ended, soonest first. */
export function shiftItems(rows: readonly ShiftRow[], now: Date): ShiftItem[] {
  return rows
    .filter((r) => (parseInstant(r.ends_at)?.getTime() ?? 0) > now.getTime())
    .sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? ""))
    .map((r) => shiftItem(r, now))
    .filter((i): i is ShiftItem => i !== null);
}

/** The latest of the member's clock events, by the device's time (the time worked, HZ-010). */
function latest(events: readonly ClockEventRow[]): ClockEventRow | null {
  let best: ClockEventRow | null = null;
  let bestAt = -Infinity;
  for (const e of events) {
    const at = parseInstant(e.device_time)?.getTime();
    if (at === undefined || !e.kind) continue;
    if (at > bestAt) {
      best = e;
      bestAt = at;
    }
  }
  return best;
}

export function clockState(events: readonly ClockEventRow[]): ClockState {
  const last = latest(events);
  if (!last) return "out";
  if (last.kind === "in" || last.kind === "break_end") return "in";
  if (last.kind === "break_start") return "on_break";
  return "out";
}

/** The shift a clock-in is for: one under way, else the next starting within the early margin. */
export function clockInShift(items: readonly ShiftItem[], rows: readonly ShiftRow[], now: Date) {
  const current = items.find((i) => i.now);
  if (current) return current;
  const soon = now.getTime() + CLOCK_IN_EARLY_MINUTES * 60_000;
  return (
    items.find((i) => {
      const start = parseInstant(rows.find((r) => r.id === i.id)?.starts_at)?.getTime();
      return start !== undefined && start >= now.getTime() && start <= soon;
    }) ?? null
  );
}

export function clockView(
  shiftRows: readonly ShiftRow[],
  events: readonly ClockEventRow[],
  now: Date,
  /** The member's only location, when they have exactly one: used when no shift says where. */
  onlyLocationId: string | null = null,
): ClockView {
  const shifts = shiftItems(shiftRows, now);
  const state = clockState(events);
  const last = latest(events);
  const lastAt = parseInstant(last?.device_time);
  const shift = clockInShift(shifts, shiftRows, now);
  const words =
    state === "out" || !lastAt
      ? t("mobile.clock.out")
      : state === "in"
        ? t("mobile.clock.in", { time: time(lastAt) })
        : t("mobile.clock.onBreak", { time: time(lastAt) });
  const action = (kind: ClockKind, key: MessageKey): ClockAction => ({
    kind,
    label: t(key),
    accessibilityLabel: shift
      ? t("mobile.clock.actionFor", { action: t(key), shift: shift.title })
      : t(key),
  });
  const actions =
    state === "out"
      ? [action("in", "mobile.clock.clockIn")]
      : state === "in"
        ? [action("break_start", "mobile.clock.startBreak"), action("out", "mobile.clock.clockOut")]
        : [action("break_end", "mobile.clock.endBreak")];
  return {
    state,
    words,
    waiting: events.filter((e) => !e.recorded_at).length,
    actions,
    shift,
    shifts,
    locationId:
      state === "out"
        ? (shift?.locationId ?? onlyLocationId)
        : (last?.location_id ?? shift?.locationId ?? onlyLocationId),
    shiftId: state === "out" ? (shift?.id ?? null) : (last?.shift_id ?? null),
  };
}
