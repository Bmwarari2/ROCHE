import type { PersonStatus } from "../people/lifecycle";
import { checkSectionVisibility, type SharingDecision } from "../people/sharing";
import { toUkWallClock } from "../shared/time";
import { ukIsoDate } from "../shared/working-days";
import type { IcsEvent } from "./notify-calendar";
import { minuteOfDayToHhMm } from "./notify-rates";

/**
 * Family visit booking through the portal (comms.md section 4 rule 17; master prompt 15.1 "visit
 * booking (Reg 9A)"). Regulation 9A of the Health and Social Care Act 2008 (Regulated Activities)
 * Regulations 2014 (in force from 6 April 2024) is about enabling visits, so online booking is a
 * convenience, never a gate: the location's booking hours limit what can be booked online, not
 * when people may visit, and every refusal offers the phone. Restrictions are decided and recorded
 * by staff in the care record with their reason (care.md, `visit_log`); this check only reads that
 * one applies. A refusal never tells the family why a restriction exists, whether the person is in
 * hospital or away, or anything else about their health: those refusals all read the same.
 */

/** Hours the location takes bookings online, in minutes after midnight UK time; one day only. */
export interface VisitBookingHours {
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * A restriction on visits in force for the person (typed placeholder: the care record has
 * per-visit restrictions with reasons, and the schema step adds standing ones). The reason stays in
 * the care record and never reaches this module.
 */
export interface VisitRestrictionView {
  readonly id: string;
  readonly appliesTo:
    | { readonly kind: "all_visitors" }
    | { readonly kind: "contact"; readonly contactId: string };
  readonly from: Date;
  /** Null while open-ended. */
  readonly to: Date | null;
}

export interface VisitBookingView {
  readonly id: string;
  readonly start: Date;
  readonly end: Date;
  readonly status: "confirmed" | "cancelled";
}

export interface VisitBookingRequest {
  readonly personId: string;
  /** The family member asking, as the contact sharing decisions name. */
  readonly contactId: string;
  readonly start: Date;
  readonly end: Date;
}

export interface VisitBookingContext {
  readonly person: { readonly id: string; readonly status: PersonStatus };
  readonly decisions: readonly SharingDecision[];
  /** Null until the location sets its online booking hours (there is no product default). */
  readonly bookingHours: VisitBookingHours | null;
  /** Booked visits the location can host at the same time; null for no limit. */
  readonly maxVisitsAtOnce: number | null;
  readonly existingBookings: readonly VisitBookingView[];
  readonly restrictions: readonly VisitRestrictionView[];
  readonly now: Date;
}

export type VisitBookingRefusal =
  | "end_not_after_start"
  | "in_the_past"
  | "wrong_person"
  | "person_not_at_home"
  | "record_closed"
  | "no_sharing_decision"
  | "restricted"
  | "not_one_day"
  | "booking_hours_not_set"
  | "outside_booking_hours"
  | "fully_booked";

/** The one message for every refusal that is about the person or a restriction. */
export const VISIT_CALL_THE_HOME =
  "We cannot book this visit online. Please call the home to arrange it.";

export type VisitBookingCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: VisitBookingRefusal;
      /** What the family member reads. */
      readonly familyMessage: string;
      /** For staff and the audit only: the restriction that applied. */
      readonly restrictionId: string | null;
    };

function refuse(
  reason: VisitBookingRefusal,
  familyMessage: string,
  restrictionId: string | null = null,
): VisitBookingCheck {
  return { ok: false, reason, familyMessage, restrictionId };
}

function overlaps(aStart: Date, aEnd: Date | null, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && (aEnd === null || aEnd.getTime() > bStart.getTime());
}

function validHours(hours: VisitBookingHours | null): hours is VisitBookingHours {
  return (
    hours !== null &&
    Number.isInteger(hours.startMinute) &&
    Number.isInteger(hours.endMinute) &&
    hours.startMinute >= 0 &&
    hours.endMinute <= 24 * 60 &&
    hours.startMinute < hours.endMinute
  );
}

/** Minutes after midnight UK time; an end at midnight counts as the end of the day before. */
function ukMinutes(at: Date, isEnd: boolean): { date: string; minute: number } {
  const w = toUkWallClock(at);
  const minute = w.hour * 60 + w.minute;
  if (isEnd && minute === 0 && w.second === 0) {
    return { date: ukIsoDate(new Date(at.getTime() - 60_000)), minute: 24 * 60 };
  }
  return { date: ukIsoDate(at), minute };
}

function hoursText(hours: VisitBookingHours): string {
  const end = hours.endMinute === 24 * 60 ? "midnight" : minuteOfDayToHhMm(hours.endMinute);
  return `${minuteOfDayToHhMm(hours.startMinute)} and ${end}`;
}

/** Checks a family member's request to book a visit, in the order that reveals least. */
export function checkVisitBooking(
  request: VisitBookingRequest,
  context: VisitBookingContext,
): VisitBookingCheck {
  if (request.end.getTime() <= request.start.getTime()) {
    return refuse("end_not_after_start", "The visit must end after it starts.");
  }
  if (request.start.getTime() <= context.now.getTime()) {
    return refuse("in_the_past", "Choose a time that has not passed.");
  }
  if (request.personId !== context.person.id) return refuse("wrong_person", VISIT_CALL_THE_HOME);
  if (context.person.status === "on_leave" || context.person.status === "in_hospital") {
    return refuse("person_not_at_home", VISIT_CALL_THE_HOME);
  }
  if (context.person.status !== "active") return refuse("record_closed", VISIT_CALL_THE_HOME);
  const shared = checkSectionVisibility(context.decisions, {
    personId: context.person.id,
    personStatus: context.person.status,
    recipient: { kind: "family", contactId: request.contactId },
    section: "activities_and_visits",
    now: context.now,
  });
  if (!shared.visible) return refuse("no_sharing_decision", VISIT_CALL_THE_HOME);
  const restriction = context.restrictions.find(
    (r) =>
      (r.appliesTo.kind === "all_visitors" || r.appliesTo.contactId === request.contactId) &&
      overlaps(r.from, r.to, request.start, request.end),
  );
  if (restriction) return refuse("restricted", VISIT_CALL_THE_HOME, restriction.id);

  const start = ukMinutes(request.start, false);
  const end = ukMinutes(request.end, true);
  if (start.date !== end.date) return refuse("not_one_day", "Book each day's visit separately.");
  if (!validHours(context.bookingHours)) {
    return refuse(
      "booking_hours_not_set",
      "Online booking is not open for this home yet. Please call the home to arrange a visit.",
    );
  }
  const hours = context.bookingHours;
  if (start.minute < hours.startMinute || end.minute > hours.endMinute) {
    return refuse(
      "outside_booking_hours",
      `You can book visits online between ${hoursText(hours)}. To visit at another time, please call the home.`,
    );
  }
  if (context.maxVisitsAtOnce !== null) {
    const booked = context.existingBookings.filter(
      (b) => b.status === "confirmed" && overlaps(b.start, b.end, request.start, request.end),
    ).length;
    if (booked >= context.maxVisitsAtOnce) {
      return refuse(
        "fully_booked",
        "This time is fully booked. Please choose another time or call the home.",
      );
    }
  }
  return { ok: true };
}

/**
 * The calendar entry for a booking (see notify-calendar.ts). It names the home, never the person:
 * a family member's calendar may be synced to services outside Harbour.
 */
export function visitBookingCalendarEvent(
  booking: VisitBookingView & { readonly sequence: number; readonly updatedAt: Date },
  location: {
    readonly name: string;
    readonly address: string | null;
    readonly phone: string | null;
  },
  uidDomain: string,
): IcsEvent {
  const phone = location.phone?.trim();
  return {
    uid: `visit-${booking.id}@${uidDomain}`,
    sequence: booking.sequence,
    status: booking.status,
    start: booking.start,
    end: booking.end,
    stampedAt: booking.updatedAt,
    summary: `Visit at ${location.name.trim()}`,
    location: location.address,
    description: `Booked through the family portal. To change or cancel it, use the portal or call the home${phone ? ` on ${phone}` : ""}.`,
  };
}
