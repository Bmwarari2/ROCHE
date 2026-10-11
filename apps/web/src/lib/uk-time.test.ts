import { createTranslator } from "@harbour/i18n";
import { afterAll, describe, expect, it } from "vitest";
import {
  addDays,
  formatUkTime,
  isIsoDate,
  isIsoInstant,
  readDateField,
  readDateTimeField,
  readWhen,
  ukToday,
} from "./uk-time";

const t = createTranslator("en-GB");

/** A form with these fields. */
const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const when = (day: string, month: string, year: string, hour: string, minute: string) => ({
  "occurredAt-mode": "earlier",
  "occurredAt-day": day,
  "occurredAt-month": month,
  "occurredAt-year": year,
  "occurredAt-hour": hour,
  "occurredAt-minute": minute,
});

// The answers must not depend on the device's zone (a laptop set to New York, a server in UTC).
const DEVICE_ZONES = ["Europe/London", "America/New_York", "UTC"] as const;
const originalZone = process.env.TZ;
afterAll(() => {
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});
function inEveryDeviceZone(check: () => void) {
  for (const zone of DEVICE_ZONES) {
    process.env.TZ = zone;
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset(), zone).toBe(
      zone === "America/New_York" ? 300 : 0,
    );
    check();
  }
}

describe("when an entry happened (hazard HZ-009)", () => {
  it("hazard HZ-009 takes 'now' when the form is sent, not when the page was drawn", () => {
    const sent = new Date("2026-10-11T13:20:00.000Z");
    expect(readWhen(form({ "occurredAt-mode": "now" }), "occurredAt", t, { now: sent })).toEqual({
      ok: true,
      instant: "2026-10-11T13:20:00.000Z",
    });
    // A form without the choice (nothing changed) is "now" too.
    expect(readWhen(form({}), "occurredAt", t, { now: sent })).toEqual({
      ok: true,
      instant: "2026-10-11T13:20:00.000Z",
    });
  });

  it("hazard HZ-009 reads an earlier UK time as one instant in summer and winter", () => {
    inEveryDeviceZone(() => {
      expect(readWhen(form(when("11", "10", "2026", "14", "05")), "occurredAt", t)).toEqual({
        ok: true,
        instant: "2026-10-11T13:05:00.000Z",
      });
      expect(readWhen(form(when("1", "12", "2026", "9", "30")), "occurredAt", t)).toEqual({
        ok: true,
        instant: "2026-12-01T09:30:00.000Z",
      });
    });
  });

  for (const [day, month, year] of [
    ["29", "3", "2026"],
    ["25", "10", "2026"],
    ["28", "3", "2027"],
    ["31", "10", "2027"],
  ] as const) {
    it(`hazard HZ-009 reads every minute of ${day}/${month}/${year} through the form`, () => {
      const forward = month === "3";
      inEveryDeviceZone(() => {
        for (let minuteOfDay = 0; minuteOfDay < 24 * 60; minuteOfDay += 1) {
          const hour = Math.floor(minuteOfDay / 60);
          const minute = minuteOfDay % 60;
          const fields = when(day, month, year, String(hour), String(minute));
          const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute);
          const label = `${hour}:${minute}`;
          const read = readWhen(form(fields), "occurredAt", t);
          if (hour === 1 && forward) {
            expect(read, label).toMatchObject({ ok: false, parts: ["hour", "minute"] });
            expect(read.ok ? "" : read.message, label).toMatch(/^The clocks went forward/);
            continue;
          }
          if (hour === 1) {
            expect(read, label).toMatchObject({ ok: false, parts: ["fold"] });
            for (const [fold, instant] of [
              ["first", asUtc - 3_600_000],
              ["second", asUtc],
            ] as const) {
              expect(
                readWhen(form({ ...fields, "occurredAt-fold": fold }), "occurredAt", t),
                `${label} ${fold}`,
              ).toEqual({ ok: true, instant: new Date(instant).toISOString() });
            }
            continue;
          }
          const summer = forward ? hour >= 2 : hour < 1;
          expect(read, label).toEqual({
            ok: true,
            instant: new Date(summer ? asUtc - 3_600_000 : asUtc).toISOString(),
          });
        }
      });
    });
  }

  it("hazard HZ-009 says the clocks went forward, and asks which time when they went back", () => {
    const skipped = readWhen(form(when("29", "3", "2026", "01", "30")), "occurredAt", t);
    expect(skipped).toEqual({
      ok: false,
      message:
        "The clocks went forward an hour at 01:00 on 29/03/2026, so 01:30 did not happen in the UK. Check the time: it may be an hour later.",
      parts: ["hour", "minute"],
    });
    const repeated = readWhen(form(when("25", "10", "2026", "1", "30")), "occurredAt", t);
    expect(repeated).toEqual({
      ok: false,
      message:
        "Choose which 01:30 it was: the clocks went back on 25/10/2026, so 01:30 happened twice.",
      parts: ["fold"],
    });
  });

  it("says which boxes of an earlier time are missing or wrong", () => {
    expect(readWhen(form(when("11", "", "2026", "14", "05")), "occurredAt", t)).toEqual({
      ok: false,
      message: "The time it happened must include a month",
      parts: ["month"],
    });
    expect(readWhen(form(when("11", "10", "2026", "14", "")), "occurredAt", t)).toEqual({
      ok: false,
      message: "The time it happened must include the minutes",
      parts: ["minute"],
    });
    expect(readWhen(form(when("11", "10", "2026", "25", "05")), "occurredAt", t)).toMatchObject({
      ok: false,
      parts: ["hour"],
    });
  });
});

describe("date fields", () => {
  const subject = "The review date";
  it("reads the day, month and year boxes as yyyy-mm-dd", () => {
    expect(
      readDateField(
        form({ "reviewDueOn-day": "5", "reviewDueOn-month": "3", "reviewDueOn-year": "2027" }),
        "reviewDueOn",
        { subject, t },
      ),
    ).toEqual({ ok: true, date: "2027-03-05" });
  });

  it("allows an optional date to be left empty, and says what is missing otherwise", () => {
    expect(readDateField(form({}), "reviewDueOn", { subject, t, optional: true })).toEqual({
      ok: true,
      date: null,
    });
    expect(readDateField(form({}), "reviewDueOn", { subject, t })).toEqual({
      ok: false,
      message: "The review date must include a day, month and year",
      parts: ["day", "month", "year"],
    });
    expect(
      readDateField(
        form({ "reviewDueOn-day": "31", "reviewDueOn-month": "4", "reviewDueOn-year": "2027" }),
        "reviewDueOn",
        { subject, t },
      ),
    ).toEqual({
      ok: false,
      message: "The review date must be a real date, for example 27 3 2026",
      parts: ["day"],
    });
    expect(
      readDateField(form({ "reviewDueOn-day": "5", "reviewDueOn-year": "2027" }), "reviewDueOn", {
        subject,
        t,
      }),
    ).toMatchObject({ message: "The review date must include a month" });
  });

  it("reads an optional date and time, such as when a visit ended", () => {
    expect(
      readDateTimeField(form({}), "endedAt", {
        subject: "The end of the visit",
        t,
        optional: true,
      }),
    ).toEqual({ ok: true, instant: null });
  });
});

describe("UK dates and times", () => {
  it("gives today's UK date, which is not the UTC date just after midnight in summer", () => {
    inEveryDeviceZone(() => {
      expect(ukToday(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
      expect(ukToday(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
    });
  });

  it("checks instants and calendar dates, and moves dates without time zones", () => {
    expect(isIsoInstant("2026-10-11T13:05:00.000Z")).toBe(true);
    expect(isIsoInstant("2026-10-11T14:05:00+01:00")).toBe(true);
    expect(isIsoInstant("2026-10-11T14:05")).toBe(false);
    expect(isIsoInstant("2026-13-41T14:05:00Z")).toBe(false);
    expect(isIsoInstant(42)).toBe(false);
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("28/02/2026")).toBe(false);
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("nonsense", 1)).toBe("nonsense");
  });

  it("shows times on the 24-hour clock in UK time", () => {
    inEveryDeviceZone(() => {
      expect(formatUkTime("2026-07-01T13:05:00Z")).toBe("14:05");
    });
    expect(formatUkTime(null)).toBeNull();
    expect(formatUkTime("x")).toBeNull();
  });
});
