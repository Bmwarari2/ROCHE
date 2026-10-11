import { describe, expect, it } from "vitest";
import type { PersonStatus } from "../people/lifecycle";
import type { SharingDecision } from "../people/sharing";
import { feedReadabilityLint, findClinicalTerms, findConfirmationTerms } from "./feed-text";
import { buildIcsCalendar } from "./notify-calendar";
import {
  checkVisitBooking,
  VISIT_BOOKING_NEEDS_A_CALL,
  VISIT_CALL_THE_HOME,
  type VisitBookingContext,
  type VisitBookingRefusal,
  type VisitBookingRequest,
  visitBookingCalendarEvent,
  visitBookingsToReview,
} from "./visit-booking";

/**
 * Family visit booking (comms.md section 4 rule 17; Regulation 9A). Invented people: Ada Example
 * and her son Ben (contact-ben). Booking hours 10:00 to 20:00 UK time in these tests.
 */

const ADA = "person-ada";
const BEN = "contact-ben";
const NOW = new Date("2026-10-11T09:00:00Z");

const decision: SharingDecision = {
  id: "d1",
  personId: ADA,
  recipient: { kind: "family", contactId: BEN },
  sections: ["activities_and_visits"],
  basis: "consent",
  consentGivenBy: "person",
  capacity: "presumed",
  validFrom: new Date("2026-10-01T00:00:00Z"),
  validTo: new Date("2027-04-01T00:00:00Z"),
  withdrawnAt: null,
  suspendedAt: null,
};

function request(overrides: Partial<VisitBookingRequest> = {}): VisitBookingRequest {
  return {
    personId: ADA,
    contactId: BEN,
    // 15:00 to 16:00 BST on Monday 12 October 2026.
    start: new Date("2026-10-12T14:00:00Z"),
    end: new Date("2026-10-12T15:00:00Z"),
    ...overrides,
  };
}

function context(overrides: Partial<VisitBookingContext> = {}): VisitBookingContext {
  return {
    person: { id: ADA, status: "active" },
    decisions: [decision],
    capacityForSharingNow: "presumed",
    bookingHours: { startMinute: 600, endMinute: 1200 },
    maxVisitsAtOnce: 2,
    existingBookings: [],
    restrictions: [],
    locationRestrictions: [],
    now: NOW,
    ...overrides,
  };
}

const refused = (
  reason: VisitBookingRefusal,
  familyMessage: string,
  restrictionId: string | null = null,
) => ({ ok: false, familyMessage, staffOnly: { reason, restrictionId } });

describe("booking a visit online", () => {
  it("books a visit inside the hours with a decision in force", () => {
    expect(checkVisitBooking(request(), context())).toEqual({ ok: true });
  });

  it.each<
    [
      string,
      Partial<VisitBookingRequest>,
      Partial<VisitBookingContext>,
      VisitBookingRefusal,
      string,
    ]
  >([
    [
      "an end before the start",
      { end: new Date("2026-10-12T13:00:00Z") },
      {},
      "end_not_after_start",
      "The visit must end after it starts.",
    ],
    [
      "a time that has passed",
      { start: new Date("2026-10-11T08:00:00Z"), end: new Date("2026-10-11T08:30:00Z") },
      {},
      "in_the_past",
      "Choose a time that has not passed.",
    ],
    [
      "a visit over midnight",
      { start: new Date("2026-10-12T18:30:00Z"), end: new Date("2026-10-13T08:00:00Z") },
      {},
      "not_one_day",
      "Book each day's visit separately.",
    ],
    [
      "hours the location has not set",
      {},
      { bookingHours: null },
      "booking_hours_not_set",
      "Online booking is not open for this home yet. Please call the home to arrange a visit.",
    ],
    [
      "hours that make no sense",
      {},
      { bookingHours: { startMinute: 1200, endMinute: 600 } },
      "booking_hours_not_set",
      "Online booking is not open for this home yet. Please call the home to arrange a visit.",
    ],
    [
      "a start before the hours",
      { start: new Date("2026-10-12T08:30:00Z") },
      {},
      "outside_booking_hours",
      "You can book visits online between 10:00 and 20:00. To visit at another time, please call the home.",
    ],
    [
      "an end after the hours",
      { end: new Date("2026-10-12T19:30:00Z") },
      {},
      "outside_booking_hours",
      "You can book visits online between 10:00 and 20:00. To visit at another time, please call the home.",
    ],
    [
      "a full slot",
      {},
      {
        existingBookings: [
          {
            id: "b1",
            start: new Date("2026-10-12T13:30:00Z"),
            end: new Date("2026-10-12T14:30:00Z"),
            status: "confirmed",
          },
          {
            id: "b2",
            start: new Date("2026-10-12T14:30:00Z"),
            end: new Date("2026-10-12T15:30:00Z"),
            status: "confirmed",
          },
        ],
      },
      "fully_booked",
      "This time is fully booked. Please choose another time or call the home.",
    ],
  ])("refuses %s", (_label, req, ctx, reason, message) => {
    expect(checkVisitBooking(request(req), context(ctx))).toEqual(refused(reason, message));
  });

  it("allows a visit that ends exactly when the hours end, and one ending at midnight when the hours run to midnight", () => {
    expect(
      checkVisitBooking(request({ end: new Date("2026-10-12T19:00:00Z") }), context()).ok,
    ).toBe(true);
    const lateHours = context({ bookingHours: { startMinute: 600, endMinute: 1440 } });
    expect(
      checkVisitBooking(
        request({ start: new Date("2026-10-12T21:00:00Z"), end: new Date("2026-10-12T23:00:00Z") }),
        lateHours,
      ),
    ).toEqual({ ok: true });
    const early = checkVisitBooking(
      request({ start: new Date("2026-10-12T07:00:00Z") }),
      lateHours,
    );
    expect(early).toMatchObject({
      familyMessage: expect.stringContaining("between 10:00 and midnight"),
    });
  });

  it("ignores cancelled bookings and ones that only touch the slot, and has no limit when none is set", () => {
    const touching = [
      {
        id: "b1",
        start: new Date("2026-10-12T13:00:00Z"),
        end: new Date("2026-10-12T14:00:00Z"),
        status: "confirmed" as const,
      },
      {
        id: "b2",
        start: new Date("2026-10-12T14:00:00Z"),
        end: new Date("2026-10-12T15:00:00Z"),
        status: "cancelled" as const,
      },
    ];
    expect(
      checkVisitBooking(request(), context({ maxVisitsAtOnce: 1, existingBookings: touching })),
    ).toEqual({ ok: true });
    const overlapping = [{ ...touching[1], status: "confirmed" } as (typeof touching)[number]];
    expect(
      checkVisitBooking(
        request(),
        context({ maxVisitsAtOnce: null, existingBookings: overlapping }),
      ),
    ).toEqual({
      ok: true,
    });
  });

  it.each<[string, string, boolean]>([
    ["10:00 BST the day before the clocks go back", "2026-10-24T09:00:00Z", true],
    ["10:00 GMT the day after", "2026-10-26T10:00:00Z", true],
    [
      "09:30 GMT the day after (an hour later in UTC than the BST limit)",
      "2026-10-26T09:30:00Z",
      false,
    ],
    ["10:00 BST the day the clocks go forward", "2026-03-29T09:00:00Z", true],
  ])("hazard HZ-009 reads booking hours on the UK clock: %s", (_label, start, ok) => {
    const begin = new Date(start);
    const result = checkVisitBooking(
      request({ start: begin, end: new Date(begin.getTime() + 60 * 60_000) }),
      context({
        now: new Date("2026-03-01T00:00:00Z"),
        decisions: [{ ...decision, validFrom: new Date("2026-02-01T00:00:00Z") }],
      }),
    );
    expect(result.ok).toBe(ok);
  });
});

describe("hazard HZ-022 a refusal never says why when the reason is about the person", () => {
  const during = { from: new Date("2026-10-10T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") };

  it.each<
    [
      string,
      Partial<VisitBookingRequest>,
      Partial<VisitBookingContext>,
      VisitBookingRefusal,
      string | null,
    ]
  >([
    [
      "the person is in hospital",
      {},
      { person: { id: ADA, status: "in_hospital" } },
      "person_not_at_home",
      null,
    ],
    [
      "the person is away on leave",
      {},
      { person: { id: ADA, status: "on_leave" } },
      "person_not_at_home",
      null,
    ],
    ["no sharing decision", {}, { decisions: [] }, "no_sharing_decision", null],
    [
      "no sharing decision while the person is in hospital (the decision is checked first)",
      {},
      { decisions: [], person: { id: ADA, status: "in_hospital" } },
      "no_sharing_decision",
      null,
    ],
    [
      "sharing suspended (safeguarding)",
      {},
      {
        decisions: [
          { ...decision, suspensions: [{ from: new Date("2026-10-10T00:00:00Z"), to: null }] },
        ],
      },
      "no_sharing_decision",
      null,
    ],
    [
      "a decision that does not cover visits",
      {},
      { decisions: [{ ...decision, sections: ["photos"] }] },
      "no_sharing_decision",
      null,
    ],
    ["a request about someone else", { personId: "person-dev" }, {}, "wrong_person", null],
    [
      "a restriction for every visitor",
      {},
      { restrictions: [{ id: "r1", appliesTo: { kind: "all_visitors" }, ...during }] },
      "restricted",
      "r1",
    ],
    [
      "a restriction on this visitor",
      {},
      {
        restrictions: [
          { id: "r2", appliesTo: { kind: "contact", contactId: BEN }, from: during.from, to: null },
        ],
      },
      "restricted",
      "r2",
    ],
    [
      "an outbreak at the location",
      {},
      {
        locationRestrictions: [{ id: "outbreak-1", kind: "outbreak", from: during.from, to: null }],
      },
      "location_restricted",
      "outbreak-1",
    ],
  ])("when %s", (_label, req, ctx, reason, restrictionId) => {
    expect(checkVisitBooking(request(req), context(ctx))).toEqual(
      refused(reason, VISIT_CALL_THE_HOME, restrictionId),
    );
  });

  it.each<PersonStatus>([
    "discharged",
    "deceased",
    "archived",
    "not_admitted",
    "enquiry",
    "pre_admission",
  ])("when the person is %s", (status) => {
    expect(checkVisitBooking(request(), context({ person: { id: ADA, status } }))).toEqual(
      refused("record_closed", VISIT_CALL_THE_HOME),
    );
  });

  it("ignores restrictions on other visitors and ones that have ended", () => {
    const restrictions = [
      { id: "r3", appliesTo: { kind: "contact" as const, contactId: "contact-cara" }, ...during },
      {
        id: "r4",
        appliesTo: { kind: "all_visitors" as const },
        from: new Date("2026-10-01T00:00:00Z"),
        to: new Date("2026-10-12T14:00:00Z"),
      },
    ];
    const locationRestrictions = [
      {
        id: "old",
        kind: "outbreak" as const,
        from: new Date("2026-09-01T00:00:00Z"),
        to: new Date("2026-09-15T00:00:00Z"),
      },
    ];
    expect(checkVisitBooking(request(), context({ restrictions, locationRestrictions }))).toEqual({
      ok: true,
    });
  });

  it("writes every family message in plain words with nothing clinical", () => {
    const messages = [
      VISIT_CALL_THE_HOME,
      VISIT_BOOKING_NEEDS_A_CALL,
      "The visit must end after it starts.",
      "Choose a time that has not passed.",
      "Book each day's visit separately.",
      "Online booking is not open for this home yet. Please call the home to arrange a visit.",
      "You can book visits online between 10:00 and 20:00. To visit at another time, please call the home.",
      "This time is fully booked. Please choose another time or call the home.",
    ];
    for (const message of messages) {
      expect(feedReadabilityLint(message)).toEqual([]);
      expect(findClinicalTerms(message)).toEqual([]);
      expect(findConfirmationTerms(message)).toEqual([]);
    }
  });
});

describe("hazard HZ-022 booked visits are checked again when something changes", () => {
  const booked = (
    id: string,
    start: string,
    contactId = BEN,
    status: "confirmed" | "cancelled" = "confirmed",
  ) => ({
    id,
    contactId,
    status,
    start: new Date(start),
    end: new Date(new Date(start).getTime() + 60 * 60_000),
  });
  const bookings = [
    booked("tomorrow", "2026-10-12T14:00:00Z"),
    booked("next-week", "2026-10-19T14:00:00Z"),
    booked("past", "2026-10-10T14:00:00Z"),
    booked("cancelled", "2026-10-13T14:00:00Z", BEN, "cancelled"),
    booked("cara", "2026-10-14T14:00:00Z", "contact-cara"),
  ];

  it("leaves bookings alone when nothing has changed", () => {
    const withCara = context({
      decisions: [
        decision,
        { ...decision, id: "d2", recipient: { kind: "family", contactId: "contact-cara" } },
      ],
    });
    expect(visitBookingsToReview(bookings, withCara)).toEqual([]);
  });

  it("lists future bookings to review after a hospital admission", () => {
    const review = visitBookingsToReview(
      bookings,
      context({ person: { id: ADA, status: "in_hospital" } }),
    );
    expect(review.map((r) => [r.bookingId, r.staffOnly.reason])).toEqual([
      ["tomorrow", "person_not_at_home"],
      ["next-week", "person_not_at_home"],
      ["cara", "no_sharing_decision"],
    ]);
    expect(review.every((r) => r.familyMessage === VISIT_BOOKING_NEEDS_A_CALL)).toBe(true);
  });

  it("lists bookings that a new restriction or outbreak covers", () => {
    const review = visitBookingsToReview(
      bookings.slice(0, 2),
      context({
        locationRestrictions: [
          { id: "outbreak-1", kind: "outbreak", from: new Date("2026-10-15T00:00:00Z"), to: null },
        ],
      }),
    );
    expect(review).toEqual([
      {
        bookingId: "next-week",
        familyMessage: VISIT_BOOKING_NEEDS_A_CALL,
        staffOnly: { reason: "location_restricted", restrictionId: "outbreak-1" },
      },
    ]);
  });

  it("lists every future booking after a death", () => {
    const review = visitBookingsToReview(
      bookings.slice(0, 2),
      context({ person: { id: ADA, status: "deceased" } }),
    );
    expect(review.map((r) => r.staffOnly.reason)).toEqual(["record_closed", "record_closed"]);
  });
});

describe("the calendar entry for a booking", () => {
  const booking = {
    id: "booking-1",
    start: new Date("2026-10-12T14:00:00Z"),
    end: new Date("2026-10-12T15:00:00Z"),
    status: "confirmed" as const,
    sequence: 0,
    updatedAt: NOW,
  };

  it("names the home and never the person", () => {
    const entry = visitBookingCalendarEvent(
      booking,
      { name: " Harbour House ", address: "1 Example Road, Exampleton", phone: "01632 960001" },
      "family.harbour.example",
    );
    expect(entry).toEqual({
      uid: "visit-booking-1@family.harbour.example",
      sequence: 0,
      status: "confirmed",
      start: booking.start,
      end: booking.end,
      stampedAt: NOW,
      summary: "Visit at Harbour House",
      location: "1 Example Road, Exampleton",
      description:
        "Booked through the family portal. To change or cancel it, use the portal or call the home on 01632 960001.",
    });
    expect(JSON.stringify(entry)).not.toContain("Ada");
    expect(buildIcsCalendar(entry).ok).toBe(true);
  });

  it("leaves the number out when the home has none", () => {
    const entry = visitBookingCalendarEvent(
      booking,
      { name: "Harbour House", address: null, phone: null },
      "family.harbour.example",
    );
    expect(entry.description).toBe(
      "Booked through the family portal. To change or cancel it, use the portal or call the home.",
    );
  });
});
