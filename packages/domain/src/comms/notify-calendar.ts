import { toUkWallClock, UK_TIME_ZONE, ukWallClockOccurrences } from "../shared/time";

/**
 * Calendar files for visit bookings (INTG-011 "calendar (ICS)"; comms.md section 4 rule 16).
 * iCalendar as RFC 5545 defines it (https://www.rfc-editor.org/rfc/rfc5545): CRLF line endings,
 * lines folded at 75 octets (3.1), TEXT values escaped (3.3.11), DTSTAMP in UTC (3.8.7.2).
 *
 * Instants are stored in UTC. The visit's start and end are written as Europe/London local time
 * with `TZID=Europe/London` and a VTIMEZONE component for it, which RFC 5545 requires for every
 * TZID used (3.6.5), so a 14:00 visit reads 14:00 in the family member's calendar on either side
 * of a clock change. RFC 5545 forbids a TZID on a UTC value (3.3.5), and reads a local time in the
 * repeated hour after the clocks go back as the first occurrence, so an instant in the second
 * occurrence is written in UTC instead and cannot be read as an hour early.
 *
 * The file is downloaded from the portal after sign-in; it is never attached to an email or SMS.
 */

export const ICS_PRODUCT_ID = "-//Thapsus Cargo Ltd//Harbour//EN";

/**
 * Europe/London rules: "the clocks go forward 1 hour at 1am on the last Sunday in March, and back
 * 1 hour at 2am on the last Sunday in October" (https://www.gov.uk/when-do-the-clocks-change).
 * The DTSTART lines are the first transitions the rules generate from; tests check every local
 * time written against the platform's own Europe/London conversion.
 */
export const EUROPE_LONDON_VTIMEZONE: readonly string[] = [
  "BEGIN:VTIMEZONE",
  `TZID:${UK_TIME_ZONE}`,
  "BEGIN:DAYLIGHT",
  "TZNAME:BST",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "DTSTART:19700329T010000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZNAME:GMT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "DTSTART:19701025T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/**
 * Escapes a TEXT value (RFC 5545 3.3.11): backslash, semicolon and comma are escaped, a line
 * break becomes "\n", and other control characters (which TEXT may not contain) are dropped.
 */
export function escapeIcsText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "\\") out += "\\\\";
    else if (ch === ";") out += "\\;";
    else if (ch === ",") out += "\\,";
    else if (ch === "\r") {
      out += "\\n";
      if (text[i + 1] === "\n") i++;
    } else if (ch === "\n") out += "\\n";
    else if (ch === "\t" || ch.charCodeAt(0) >= 0x20) {
      if (ch.charCodeAt(0) !== 0x7f) out += ch;
    }
  }
  return out;
}

/** Octets a code point takes in UTF-8. */
function utf8Length(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * Folds a content line at 75 octets (RFC 5545 3.1): each continuation starts with one space.
 * A multi-byte UTF-8 character is never split.
 */
export function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const size = utf8Length(ch);
    const limit = parts.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** "20261024T130000Z" (RFC 5545 3.3.5, form 2). */
export function icsUtc(instant: Date): string {
  return `${instant.getUTCFullYear()}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}T${pad(
    instant.getUTCHours(),
  )}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`;
}

/**
 * A DATE-TIME property for an instant: Europe/London local time with its TZID, or UTC when the
 * local time is the second of two (the hour repeated when the clocks go back).
 */
export function icsDateTimeProperty(name: string, instant: Date): string {
  const w = toUkWallClock(instant);
  const [first] = ukWallClockOccurrences(w.year, w.month, w.day, w.hour, w.minute);
  const wholeMinute = Math.floor(instant.getTime() / 60_000) * 60_000;
  if (first?.getTime() !== wholeMinute) return `${name}:${icsUtc(instant)}`;
  const local = `${w.year}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`;
  return `${name};TZID=${UK_TIME_ZONE}:${local}`;
}

export interface IcsEvent {
  /** Stable for the booking, globally unique: an opaque id and the portal's domain. */
  readonly uid: string;
  /** Raised by one each time the booking changes (RFC 5545 3.8.7.4). */
  readonly sequence: number;
  readonly status: "confirmed" | "cancelled";
  readonly start: Date;
  readonly end: Date;
  /** When this version of the file was made (DTSTAMP). */
  readonly stampedAt: Date;
  readonly summary: string;
  readonly location: string | null;
  readonly description: string | null;
}

export type IcsEventProblem =
  | "uid_not_valid"
  | "sequence_not_valid"
  | "end_not_after_start"
  | "summary_required";

export function checkIcsEvent(event: IcsEvent): IcsEventProblem[] {
  const problems: IcsEventProblem[] = [];
  const at = event.uid.indexOf("@");
  if (at <= 0 || at === event.uid.length - 1) problems.push("uid_not_valid");
  for (const ch of event.uid) {
    if (ch === " " || ch === "\r" || ch === "\n" || ch === ";" || ch === ",") {
      problems.push("uid_not_valid");
      break;
    }
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 0) problems.push("sequence_not_valid");
  if (event.end.getTime() <= event.start.getTime()) problems.push("end_not_after_start");
  if (event.summary.trim().length === 0) problems.push("summary_required");
  return [...new Set(problems)];
}

/**
 * The whole calendar file for one event, or the problems that stop it. The file has no METHOD: it
 * is published for download, not sent as an iTIP invitation (RFC 5546).
 */
export function buildIcsCalendar(
  event: IcsEvent,
):
  | { readonly ok: true; readonly ics: string }
  | { readonly ok: false; readonly problems: readonly IcsEventProblem[] } {
  const problems = checkIcsEvent(event);
  if (problems.length > 0) return { ok: false, problems };
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODUCT_ID}`,
    "CALSCALE:GREGORIAN",
    ...EUROPE_LONDON_VTIMEZONE,
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${icsUtc(event.stampedAt)}`,
    icsDateTimeProperty("DTSTART", event.start),
    icsDateTimeProperty("DTEND", event.end),
    `SEQUENCE:${event.sequence}`,
    `STATUS:${event.status === "confirmed" ? "CONFIRMED" : "CANCELLED"}`,
    `SUMMARY:${escapeIcsText(event.summary.trim())}`,
    ...(event.location ? [`LOCATION:${escapeIcsText(event.location.trim())}`] : []),
    ...(event.description ? [`DESCRIPTION:${escapeIcsText(event.description.trim())}`] : []),
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return { ok: true, ics: `${lines.map(foldIcsLine).join("\r\n")}\r\n` };
}
