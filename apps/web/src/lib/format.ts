/**
 * UK formats (CONTENT.md, section 5.4): dates dd/mm/yyyy, 24-hour times in UK local time, NHS
 * numbers in 3-3-4 groups. Pure functions, unit tested.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A calendar date ("1938-02-01") as dd/mm/yyyy. Parsed as text, never through Date, so a date of
 * birth cannot shift by a day across time zones or clock changes.
 */
export function formatDate(isoDate: string | null | undefined): string | null {
  if (!isoDate) return null;
  const match = ISO_DATE.exec(isoDate);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An instant as "03/10/2026 14:05" in UK local time. */
export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    dateTimeFormatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/** "9990000018" as "999 000 0018". Anything that is not 10 digits is returned unchanged. */
export function formatNhsNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\s+/g, "");
  if (!/^\d{10}$/.test(digits)) return value;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}
