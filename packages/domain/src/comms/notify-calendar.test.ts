import { describe, expect, it } from "vitest";
import { toUkWallClock, ukOffsetMinutes } from "../shared/time";
import {
  buildIcsCalendar,
  checkIcsEvent,
  EUROPE_LONDON_VTIMEZONE,
  escapeIcsText,
  foldIcsLine,
  ICS_PRODUCT_ID,
  type IcsEvent,
  icsDateTimeProperty,
  icsUtc,
} from "./notify-calendar";

/**
 * Calendar files for visit bookings (comms.md section 4 rule 16; RFC 5545). Times are checked on
 * both sides of the 2026 clock changes: forward on Sunday 29 March, back on Sunday 25 October.
 */

function octets(line: string): number {
  let n = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return n;
}

const unfold = (text: string) => text.split("\r\n ").join("");

function event(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "visit-0192a7c4-booking@family.harbour.example",
    sequence: 0,
    status: "confirmed",
    start: new Date("2026-10-24T13:00:00Z"),
    end: new Date("2026-10-24T14:00:00Z"),
    stampedAt: new Date("2026-10-11T09:30:00Z"),
    summary: "Visit at Harbour House",
    location: "1 Example Road, Exampleton",
    description: "Booked through the family portal.",
    ...overrides,
  };
}

describe("text values (RFC 5545 3.3.11)", () => {
  it.each<[string, string, string]>([
    [
      "commas, semicolons and backslashes",
      "Tea, cake; \\ biscuits",
      "Tea\\, cake\\; \\\\ biscuits",
    ],
    ["a line feed", "Ring the bell\nthen wait", "Ring the bell\\nthen wait"],
    ["a CRLF pair as one break", "Line one\r\nLine two", "Line one\\nLine two"],
    ["a lone carriage return", "One\rTwo", "One\\nTwo"],
    ["control characters", "Bell\u0007 and delete\u007f gone", "Bell and delete gone"],
    ["a tab and accents", "Zoë\tvisits", "Zoë\tvisits"],
  ])("escapes %s", (_label, text, expected) => {
    expect(escapeIcsText(text)).toBe(expected);
  });
});

describe("line folding (RFC 5545 3.1)", () => {
  it("leaves a line of 75 octets alone and folds one of 76", () => {
    const exact = "a".repeat(75);
    expect(foldIcsLine(exact)).toBe(exact);
    expect(foldIcsLine(`${exact}b`)).toBe(`${exact}\r\n b`);
  });

  it("counts a four-octet character as four", () => {
    const wide = "\u{1D400}"; // MATHEMATICAL BOLD CAPITAL A, four octets in UTF-8
    const folded = foldIcsLine(`${"a".repeat(72)}${wide}${wide}`);
    expect(folded).toBe(`${"a".repeat(72)}\r\n ${wide}${wide}`);
  });

  it("never splits a multi-byte character and keeps every line within 75 octets", () => {
    const line = `DESCRIPTION:${"Zoë and Siân. ".repeat(20)}`;
    const folded = foldIcsLine(line);
    expect(unfold(folded)).toBe(line);
    for (const physical of folded.split("\r\n")) expect(octets(physical)).toBeLessThanOrEqual(75);
  });
});

describe("hazard HZ-009 visit times read the same on either side of a clock change", () => {
  it.each<[string, string, string]>([
    [
      "14:00 BST the day before the clocks go back",
      "2026-10-24T13:00:00Z",
      "DTSTART;TZID=Europe/London:20261024T140000",
    ],
    [
      "14:00 GMT the day after the clocks go back",
      "2026-10-26T14:00:00Z",
      "DTSTART;TZID=Europe/London:20261026T140000",
    ],
    [
      "14:00 GMT the day before the clocks go forward",
      "2026-03-28T14:00:00Z",
      "DTSTART;TZID=Europe/London:20260328T140000",
    ],
    [
      "14:00 BST the day after the clocks go forward",
      "2026-03-30T13:00:00Z",
      "DTSTART;TZID=Europe/London:20260330T140000",
    ],
    [
      "02:30 BST, just after the skipped hour",
      "2026-03-29T01:30:00Z",
      "DTSTART;TZID=Europe/London:20260329T023000",
    ],
    [
      "01:30 BST, the first of the repeated hour",
      "2026-10-25T00:30:00Z",
      "DTSTART;TZID=Europe/London:20261025T013000",
    ],
    [
      "01:30 GMT, the second of the repeated hour, written in UTC",
      "2026-10-25T01:30:00Z",
      "DTSTART:20261025T013000Z",
    ],
  ])("writes %s", (_label, instant, line) => {
    expect(icsDateTimeProperty("DTSTART", new Date(instant))).toBe(line);
  });

  it("keeps seconds and writes UTC values with a Z", () => {
    expect(icsUtc(new Date("2026-10-11T09:30:05Z"))).toBe("20261011T093005Z");
    expect(icsDateTimeProperty("DTEND", new Date("2026-07-01T09:30:05Z"))).toBe(
      "DTEND;TZID=Europe/London:20260701T103005",
    );
  });

  it("agrees with the platform's Europe/London conversion on every half hour of 2026's clock-change weekends", () => {
    for (const [from, to] of [
      ["2026-03-28T00:00:00Z", "2026-03-30T00:00:00Z"],
      ["2026-10-24T00:00:00Z", "2026-10-26T00:00:00Z"],
    ] as const) {
      for (let t = Date.parse(from); t < Date.parse(to); t += 30 * 60_000) {
        const instant = new Date(t);
        const line = icsDateTimeProperty("DTSTART", instant);
        if (line.endsWith("Z")) {
          expect(line).toBe(`DTSTART:${icsUtc(instant)}`);
          continue;
        }
        const w = toUkWallClock(instant);
        const pad = (n: number) => String(n).padStart(2, "0");
        expect(line).toBe(
          `DTSTART;TZID=Europe/London:${w.year}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}00`,
        );
      }
    }
  });

  it("describes Europe/London with the rule the platform's time zone data follows", () => {
    // The VTIMEZONE says: last Sunday of March, 01:00 local GMT, to +0100; last Sunday of October,
    // 02:00 local BST, back to +0000. Both are 01:00 UTC. Check that rule against ukOffsetMinutes.
    expect(EUROPE_LONDON_VTIMEZONE).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU");
    expect(EUROPE_LONDON_VTIMEZONE).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
    const lastSunday = (year: number, monthIndex: number) => {
      const last = new Date(Date.UTC(year, monthIndex + 1, 0));
      return last.getUTCDate() - last.getUTCDay();
    };
    for (let year = 2026; year <= 2035; year++) {
      const spring = Date.UTC(year, 2, lastSunday(year, 2), 1, 0);
      const autumn = Date.UTC(year, 9, lastSunday(year, 9), 1, 0);
      expect(ukOffsetMinutes(new Date(spring - 60_000))).toBe(0);
      expect(ukOffsetMinutes(new Date(spring))).toBe(60);
      expect(ukOffsetMinutes(new Date(autumn - 60_000))).toBe(60);
      expect(ukOffsetMinutes(new Date(autumn))).toBe(0);
    }
  });
});

describe("the calendar file", () => {
  it("builds a complete VCALENDAR with CRLF endings and no METHOD", () => {
    const result = buildIcsCalendar(event());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ics.endsWith("\r\n")).toBe(true);
    expect(result.ics.replaceAll("\r\n", "").includes("\n")).toBe(false);
    expect(result.ics.split("\r\n").slice(0, -1)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:${ICS_PRODUCT_ID}`,
      "CALSCALE:GREGORIAN",
      ...EUROPE_LONDON_VTIMEZONE,
      "BEGIN:VEVENT",
      "UID:visit-0192a7c4-booking@family.harbour.example",
      "DTSTAMP:20261011T093000Z",
      "DTSTART;TZID=Europe/London:20261024T140000",
      "DTEND;TZID=Europe/London:20261024T150000",
      "SEQUENCE:0",
      "STATUS:CONFIRMED",
      "SUMMARY:Visit at Harbour House",
      "LOCATION:1 Example Road\\, Exampleton",
      "DESCRIPTION:Booked through the family portal.",
      "TRANSP:OPAQUE",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    expect(result.ics).not.toContain("METHOD:");
  });

  it("marks a cancellation with a higher sequence and leaves out empty fields", () => {
    const result = buildIcsCalendar(
      event({ status: "cancelled", sequence: 2, location: null, description: null }),
    );
    expect(result.ok && result.ics).toContain("SEQUENCE:2\r\nSTATUS:CANCELLED\r\nSUMMARY:");
    expect(result.ok && result.ics).not.toContain("LOCATION:");
    expect(result.ok && result.ics).not.toContain("DESCRIPTION:");
  });

  it("folds long descriptions so no line passes 75 octets", () => {
    const result = buildIcsCalendar(
      event({ description: "Please sign in at reception, then wait. ".repeat(10) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      for (const line of result.ics.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75);
  });

  it.each<[string, Partial<IcsEvent>, readonly string[]]>([
    ["a UID without a domain", { uid: "visit-1" }, ["uid_not_valid"]],
    ["a UID with a space", { uid: "visit 1@family.harbour.example" }, ["uid_not_valid"]],
    ["a UID ending at the @", { uid: "visit-1@" }, ["uid_not_valid"]],
    ["a negative sequence", { sequence: -1 }, ["sequence_not_valid"]],
    ["a fractional sequence", { sequence: 1.5 }, ["sequence_not_valid"]],
    ["an end before the start", { end: new Date("2026-10-24T12:00:00Z") }, ["end_not_after_start"]],
    ["an empty summary", { summary: "  " }, ["summary_required"]],
  ])("refuses %s", (_label, overrides, problems) => {
    expect(checkIcsEvent(event(overrides))).toEqual(problems);
    expect(buildIcsCalendar(event(overrides))).toEqual({ ok: false, problems });
  });
});
