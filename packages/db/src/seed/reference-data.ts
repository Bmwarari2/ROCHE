/**
 * Parses the statutory figures (docs/specs/rates.md) and the retention schedule
 * (docs/specs/retention.md) into rows for the global reference tables. The documents are the
 * source of truth that people review; the seed keeps the database identical to them.
 */

export interface RateSeedRow {
  readonly key: string;
  readonly value: string;
  readonly unit: string;
  readonly nation: string;
  /** ISO date, inclusive. */
  readonly validFrom: string;
  /** ISO date, exclusive (the day after the document's last day in force); null if open-ended. */
  readonly validTo: string | null;
  readonly source: string;
  readonly verificationStatus: string;
}

export interface RetentionSeedRow {
  readonly recordClass: string;
  readonly period: number;
  readonly unit: "years" | "months";
  readonly trigger: string;
  readonly source: string;
  readonly notes: string | null;
}

export interface BankHolidaySeedRow {
  /** ISO date. */
  readonly date: string;
  readonly nation: "england" | "wales" | "scotland" | "northern_ireland";
  readonly name: string;
}

export class ReferenceDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceDataError";
  }
}

const NATIONS = new Set(["england", "wales", "scotland", "northern_ireland", "uk", "all"]);
const STATUSES = new Set(["master-prompt", "verified", "to-verify"]);
const TRIGGERS = new Set([
  "care_ended",
  "last_entry",
  "record_closed",
  "employment_ended_or_75th_birthday",
  "created",
  "tenant_policy",
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns the rows of the first markdown table after `heading`, as arrays of trimmed cells. */
export function tableUnderHeading(markdown: string, heading: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) throw new ReferenceDataError(`Heading not found: ${heading}`);
  const rows: string[][] = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("|")) {
      inTable = true;
      rows.push(
        line
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim()),
      );
    } else if (inTable) {
      break;
    } else if (line.startsWith("#")) {
      break;
    }
  }
  if (rows.length < 2) throw new ReferenceDataError(`No table under ${heading}`);
  // Drop the header and the separator row.
  return rows.slice(2);
}

function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Figures a device turns into a list of days (one sync bucket per person and day), checked when
 * the seed reads them: the sync service limits buckets per connection, so a figure outside these
 * bounds is refused here rather than at the first token (`packages/sync/src/client/window.ts`).
 */
const DEVICE_DAY_RANGES: Readonly<Record<string, { readonly min: number; readonly max: number }>> =
  {
    "mobile.offline_window_days": { min: 1, max: 31 },
    "mobile.held_entries_max_days": { min: 1, max: 31 },
  };

export function parseRates(markdown: string): RateSeedRow[] {
  return tableUnderHeading(markdown, "## Rate table").map((cells, index) => {
    const where = `rates.md row ${index + 1}`;
    if (cells.length !== 8)
      throw new ReferenceDataError(`${where}: expected 8 columns, got ${cells.length}`);
    const [key, value, unit, validFrom, validTo, nation, source, status] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(key))
      throw new ReferenceDataError(`${where}: bad key ${key}`);
    if (!/^-?\d+(\.\d+)?$/.test(value))
      throw new ReferenceDataError(`${where}: value is not a number: ${value}`);
    if (!ISO_DATE.test(validFrom))
      throw new ReferenceDataError(`${where}: bad valid_from ${validFrom}`);
    if (validTo !== "-" && !ISO_DATE.test(validTo)) {
      throw new ReferenceDataError(`${where}: bad valid_to ${validTo}`);
    }
    if (!NATIONS.has(nation)) throw new ReferenceDataError(`${where}: unknown nation ${nation}`);
    if (!STATUSES.has(status)) throw new ReferenceDataError(`${where}: unknown status ${status}`);
    if (!unit) throw new ReferenceDataError(`${where}: missing unit`);
    const dayRange = DEVICE_DAY_RANGES[key];
    if (dayRange) {
      const days = Number(value);
      if (
        !Number.isInteger(days) ||
        days < dayRange.min ||
        days > dayRange.max ||
        unit !== "days"
      ) {
        throw new ReferenceDataError(
          `${where}: ${key} must be a whole number of days from ${dayRange.min} to ${dayRange.max}`,
        );
      }
    }
    return {
      key,
      value,
      unit,
      nation,
      validFrom,
      // The document lists the last day a figure is in force; the database stores an exclusive end.
      validTo: validTo === "-" ? null : dayAfter(validTo),
      source,
      verificationStatus: status,
    };
  });
}

export function parseRetention(markdown: string): RetentionSeedRow[] {
  return tableUnderHeading(markdown, "## Retention schedule").map((cells, index) => {
    const where = `retention.md row ${index + 1}`;
    if (cells.length !== 6)
      throw new ReferenceDataError(`${where}: expected 6 columns, got ${cells.length}`);
    const [recordClass, period, unit, trigger, source, notes] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^[a-z0-9_.]+$/.test(recordClass))
      throw new ReferenceDataError(`${where}: bad class ${recordClass}`);
    if (!/^\d+$/.test(period))
      throw new ReferenceDataError(`${where}: period is not a whole number`);
    if (unit !== "years" && unit !== "months")
      throw new ReferenceDataError(`${where}: bad unit ${unit}`);
    if (!TRIGGERS.has(trigger))
      throw new ReferenceDataError(`${where}: unknown trigger ${trigger}`);
    return {
      recordClass,
      period: Number(period),
      unit,
      trigger,
      source,
      notes: notes === "" || notes === "-" ? null : notes,
    };
  });
}

/** An ISO date that exists (not 30 February or month 13). */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const HOLIDAY_NATIONS = new Set(["england", "wales", "scotland", "northern_ireland"]);

export function parseBankHolidays(markdown: string): BankHolidaySeedRow[] {
  const seen = new Set<string>();
  return tableUnderHeading(markdown, "## Bank holidays").map((cells, index) => {
    const where = `calendar.md row ${index + 1}`;
    if (cells.length !== 3)
      throw new ReferenceDataError(`${where}: expected 3 columns, got ${cells.length}`);
    const [date, nation, name] = cells as [string, string, string];
    if (!isCalendarDate(date)) throw new ReferenceDataError(`${where}: bad date ${date}`);
    if (!HOLIDAY_NATIONS.has(nation))
      throw new ReferenceDataError(`${where}: unknown nation ${nation}`);
    if (!name) throw new ReferenceDataError(`${where}: missing name`);
    if (seen.has(`${nation}|${date}`))
      throw new ReferenceDataError(`${where}: ${date} is listed twice for ${nation}`);
    seen.add(`${nation}|${date}`);
    return { date, nation: nation as BankHolidaySeedRow["nation"], name };
  });
}

/** Overlapping periods for the same key and nation would make a lookup ambiguous. */
export function findOverlaps(rows: readonly RateSeedRow[]): string[] {
  const problems: string[] = [];
  const groups = new Map<string, RateSeedRow[]>();
  for (const row of rows) {
    const k = `${row.key}|${row.nation}`;
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  for (const [k, group] of groups) {
    const sorted = [...group].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev && cur && (prev.validTo === null || prev.validTo > cur.validFrom)) {
        problems.push(`${k}: ${prev.validFrom} overlaps ${cur.validFrom}`);
      }
    }
  }
  return problems;
}
