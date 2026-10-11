import { hasReason, isCalendarDate, plusDays } from "./dates";

/**
 * Rooms, beds and move history (master prompt section 9.2; people.md section 4 rule 6). Each
 * period of occupancy is a dated, half-open range [from, to) of calendar dates in the location's
 * time zone: a person who moves on 12 October leaves the old bed on that day and occupies the new
 * one from that day. A bed never has two occupants at once, a person never occupies two beds at
 * once, and every move is dated and has a reason. A person in hospital or on leave keeps their
 * bed (the period stays open). A wrong room is a wrong-person risk (HZ-001), so the current room
 * shown on point-of-care screens comes from this history.
 */

export const ROOM_STATUSES = ["available", "out_of_service", "awaiting_clearance"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export interface RoomView {
  readonly id: string;
  readonly label: string;
  /** Number of beds; beds are numbered 1 to `beds`. */
  readonly beds: number;
  readonly status: RoomStatus;
}

export interface BedOccupancy {
  readonly id: string;
  readonly personId: string;
  readonly roomId: string;
  readonly bed: number;
  /** First day in the bed (yyyy-mm-dd). */
  readonly from: string;
  /** Day the person left the bed (yyyy-mm-dd, exclusive); null while they still occupy it. */
  readonly to: string | null;
}

export type OccupancyProblem =
  | {
      readonly kind: "bed_double_booked";
      readonly roomId: string;
      readonly bed: number;
      readonly periodIds: readonly [string, string];
    }
  | {
      readonly kind: "person_in_two_beds";
      readonly personId: string;
      readonly periodIds: readonly [string, string];
    }
  | { readonly kind: "ends_before_start"; readonly periodId: string }
  | { readonly kind: "invalid_date"; readonly periodId: string }
  | { readonly kind: "no_such_bed"; readonly periodId: string };

function overlaps(a: BedOccupancy, b: BedOccupancy): boolean {
  const aEndsAfterBStarts = a.to === null || a.to > b.from;
  const bEndsAfterAStarts = b.to === null || b.to > a.from;
  return aEndsAfterBStarts && bEndsAfterAStarts;
}

/** Checks a whole history (the database also refuses overlaps with exclusion constraints). */
export function checkOccupancyHistory(
  periods: readonly BedOccupancy[],
  rooms: readonly RoomView[],
): OccupancyProblem[] {
  const problems: OccupancyProblem[] = [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const valid: BedOccupancy[] = [];
  for (const p of periods) {
    if (!isCalendarDate(p.from) || (p.to !== null && !isCalendarDate(p.to))) {
      problems.push({ kind: "invalid_date", periodId: p.id });
      continue;
    }
    if (p.to !== null && p.to <= p.from) {
      problems.push({ kind: "ends_before_start", periodId: p.id });
      continue;
    }
    const room = roomById.get(p.roomId);
    if (!room || !Number.isInteger(p.bed) || p.bed < 1 || p.bed > room.beds) {
      problems.push({ kind: "no_such_bed", periodId: p.id });
      continue;
    }
    valid.push(p);
  }
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i] as BedOccupancy;
      const b = valid[j] as BedOccupancy;
      if (!overlaps(a, b)) continue;
      if (a.roomId === b.roomId && a.bed === b.bed && a.personId !== b.personId) {
        problems.push({
          kind: "bed_double_booked",
          roomId: a.roomId,
          bed: a.bed,
          periodIds: [a.id, b.id],
        });
      }
      if (a.personId === b.personId) {
        problems.push({
          kind: "person_in_two_beds",
          personId: a.personId,
          periodIds: [a.id, b.id],
        });
      }
    }
  }
  return problems;
}

function covers(p: BedOccupancy, on: string): boolean {
  return p.from <= on && (p.to === null || p.to > on);
}

/** Who occupies a bed on a date, or null. */
export function bedOccupantOn(
  periods: readonly BedOccupancy[],
  roomId: string,
  bed: number,
  on: string,
): string | null {
  return (
    periods.find((p) => p.roomId === roomId && p.bed === bed && covers(p, on))?.personId ?? null
  );
}

/** The person's bed on a date, or null. */
export function personBedOn(
  periods: readonly BedOccupancy[],
  personId: string,
  on: string,
): BedOccupancy | null {
  return periods.find((p) => p.personId === personId && covers(p, on)) ?? null;
}

/** The room label to show on the person's header on a date (the `person.room_label` cache). */
export function roomLabelOn(
  periods: readonly BedOccupancy[],
  rooms: readonly RoomView[],
  personId: string,
  on: string,
): string | null {
  const period = personBedOn(periods, personId, on);
  if (!period) return null;
  const room = rooms.find((r) => r.id === period.roomId);
  if (!room) return null;
  return room.beds > 1 ? `${room.label}, bed ${period.bed}` : room.label;
}

/** The person's moves in date order, for the history view. */
export function moveHistory(periods: readonly BedOccupancy[], personId: string): BedOccupancy[] {
  return periods
    .filter((p) => p.personId === personId)
    .sort((a, b) => (a.from === b.from ? a.id.localeCompare(b.id) : a.from < b.from ? -1 : 1));
}

export const MIN_MOVE_REASON_LENGTH = 3;

export interface BedMoveRequest {
  readonly personId: string;
  readonly toRoomId: string;
  readonly toBed: number;
  /** The day of the move or admission (yyyy-mm-dd). */
  readonly on: string;
  readonly reason: string;
}

export type BedMoveProblem =
  | "invalid_date"
  | "move_in_future"
  | "no_such_bed"
  | "room_unavailable"
  | "bed_occupied"
  | "same_bed"
  | "before_current_start"
  | "same_day_as_current_start"
  | "reason_required";

export type BedMovePlan =
  | {
      readonly ok: true;
      /** The current period to end on the move day, or null for a first admission. */
      readonly close: { readonly periodId: string; readonly to: string } | null;
      readonly open: Omit<BedOccupancy, "id">;
      /** True when the move is recorded after the day it happened; the history shows it. */
      readonly backdated: boolean;
    }
  | { readonly ok: false; readonly problem: BedMoveProblem; readonly message: string };

const MOVE_MESSAGES: Record<BedMoveProblem, string> = {
  invalid_date: "Enter the date of the move as a real date.",
  move_in_future: "Record a move on the day it happens. Plan future moves as a task.",
  no_such_bed: "That room does not have that bed.",
  room_unavailable: "That room is not available for anyone to move into.",
  bed_occupied: "Someone else occupies that bed on or after that date.",
  same_bed: "The person is already in that bed.",
  before_current_start: "The move cannot be before the person moved into their current bed.",
  same_day_as_current_start:
    "The person moved into their current bed on that day. Correct that entry instead.",
  reason_required: "Give a reason for the move.",
};

function moveProblem(problem: BedMoveProblem): BedMovePlan {
  return { ok: false, problem, message: MOVE_MESSAGES[problem] };
}

/**
 * Plans an admission into a bed or a move between beds: which period to close and which to open.
 * `today` is the location's calendar date.
 */
export function planBedMove(
  periods: readonly BedOccupancy[],
  rooms: readonly RoomView[],
  request: BedMoveRequest,
  today: string,
): BedMovePlan {
  if (!isCalendarDate(request.on)) return moveProblem("invalid_date");
  if (request.on > today) return moveProblem("move_in_future");
  const room = rooms.find((r) => r.id === request.toRoomId);
  if (!room || !Number.isInteger(request.toBed) || request.toBed < 1 || request.toBed > room.beds) {
    return moveProblem("no_such_bed");
  }
  if (room.status !== "available") return moveProblem("room_unavailable");
  if (!hasReason(request.reason, MIN_MOVE_REASON_LENGTH)) return moveProblem("reason_required");

  const current = periods.find((p) => p.personId === request.personId && p.to === null) ?? null;
  if (current) {
    if (current.roomId === request.toRoomId && current.bed === request.toBed) {
      return moveProblem("same_bed");
    }
    if (request.on < current.from) return moveProblem("before_current_start");
    if (request.on === current.from) return moveProblem("same_day_as_current_start");
  }
  const clash = periods.some(
    (p) =>
      p.personId !== request.personId &&
      p.roomId === request.toRoomId &&
      p.bed === request.toBed &&
      (p.to === null || p.to > request.on),
  );
  if (clash) return moveProblem("bed_occupied");
  return {
    ok: true,
    close: current ? { periodId: current.id, to: request.on } : null,
    open: {
      personId: request.personId,
      roomId: request.toRoomId,
      bed: request.toBed,
      from: request.on,
      to: null,
    },
    backdated: request.on < today,
  };
}

/** Ends the person's occupancy on the day they leave (discharge) or the room is cleared (death). */
export function planBedRelease(
  periods: readonly BedOccupancy[],
  personId: string,
  on: string,
): { readonly periodId: string; readonly to: string } | null {
  const current = periods.find((p) => p.personId === personId && p.to === null);
  if (!current || !isCalendarDate(on) || on < current.from) return null;
  // Leaving on the day of arrival still records one day in the bed.
  const to = on === current.from ? plusDays(on, 1) : on;
  return { periodId: current.id, to };
}
