import type { AllergyStatement, CommunicationStatement, MarEntry } from "@harbour/domain";
import {
  formatDoseQuantity,
  formatNhsNumber,
  formatUkDateTimeWithZone,
  isTimeCritical,
  marEntryDoses,
  marEntryEnd,
  marEntryStatus,
  marEntryTimesBeforeRecorded,
  REASON_WORDS,
} from "@harbour/domain";
import type { AdministrationRow } from "./medicine-administrations";
import { directionsInWords, UNCHECKED_POLICY } from "./medicines";
import { type PdfLine, renderPdf } from "./pdf";
import { ukDate, ukDateTime } from "./transfer-pack-pdf";

/**
 * The printable MAR chart (Phase 2 slice 50; MEDS-014; medicines.md section 17): one person, one
 * calendar month, from the eMAR. It shows:
 * - the person on every page, with date of birth and NHS number;
 * - the allergies and communication needs (HZ-007, AIS);
 * - each medicine with its directions;
 * - every scheduled dose of the month by day, with its outcome as a code, the time given when it
 *   differs, the amount, the reason, the giver's initials, and covert and corrected marks;
 * - when-required doses as recorded;
 * - a key to the codes and the staff initials.
 *
 * Every page says when it was printed and that it is not the live record (HZ-122). It shows the
 * record and never says what to give (medical-device boundary).
 */

export const MAR_OUTCOME_CODES = {
  given: "G",
  refused: "R",
  omitted: "N",
  withheld: "W",
  not_available: "U",
  self_administered: "S",
  given_by_family: "F",
} as const;
export type MarOutcome = keyof typeof MAR_OUTCOME_CODES;

const OUTCOME_WORDS: Readonly<Record<MarOutcome, string>> = {
  given: "given",
  refused: "refused by the person",
  omitted: "not given, with the reason (for example asleep or in hospital)",
  withheld: "withheld on purpose, with the reason (for example the prescriber's instruction)",
  not_available: "not available",
  self_administered: "taken by the person themselves",
  given_by_family: "given by family, as agreed",
};

export interface MarRecord {
  readonly outcome: MarOutcome;
  readonly givenAt: Date;
  /** Who gave it (the administering member's id). */
  readonly by: string | null;
  readonly covert: boolean;
  /** This record corrects an earlier one. */
  readonly corrected: boolean;
  /** The amount given in words ("15 ml"). */
  readonly amount: string | null;
  /** Why it was not given, in words. */
  readonly reason: string | null;
}

export interface MarDoseCell {
  readonly dueAt: Date;
  /** The UK date (yyyy-mm-dd) and clock time of the dose. */
  readonly date: string;
  readonly time: string;
  readonly dayName: string;
  /** A time before the entry was recorded: not due. */
  readonly notDue: boolean;
  readonly record: MarRecord | null;
}

export interface MarPrintEntry {
  readonly productName: string;
  readonly version: number;
  readonly route: string;
  readonly directions: string;
  readonly kind: "regular" | "when_required";
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly prescriber: string;
  /** The entry's status now, in words ("Checked", "Not yet checked", "Replaced by a newer entry"). */
  readonly status: string;
  readonly timeCritical: boolean;
  readonly doses: readonly MarDoseCell[];
  /** When-required doses recorded in the month, oldest first. */
  readonly prnRecords: readonly MarRecord[];
  /** Records of a scheduled dose that match no dose time on the chart: printed, never dropped. */
  readonly unmatched: readonly MarRecord[];
}

export interface MarPrintInput {
  readonly person: {
    readonly name: string;
    readonly preferredName: string | null;
    readonly dateOfBirth: string | null;
    readonly nhsNumber: string | null;
    readonly locationName: string;
  };
  /** The month as "November 2026", and its UK start (inclusive) and end (exclusive). */
  readonly month: { readonly label: string; readonly from: Date; readonly to: Date };
  readonly allergies: AllergyStatement;
  readonly communication: CommunicationStatement;
  readonly entries: readonly MarPrintEntry[];
  /** Staff initials (unique on the chart) and names by id. */
  readonly staff: (
    id: string | null,
  ) => { readonly name: string; readonly initials: string } | null;
  readonly printedAt: Date;
}

/** The notice on every page: when it was printed, and that it is not the live record (HZ-122). */
export function marPrintedNotice(printedAt: Date): string {
  return `Printed from the eMAR at ${formatUkDateTimeWithZone(printedAt)}. This is not the live record: check the eMAR before giving or holding any medicine.`;
}

/** Initials from a name: the first letter of each word, at most three ("Ada Example" is "AE"). */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3);
}

/**
 * Initials that are unique on the chart: two people with the same initials get a number each
 * ("AE1", "AE2"), in the order of their names, so a reader can always tell who gave a dose.
 */
export function uniqueInitials(
  people: readonly { readonly id: string; readonly name: string }[],
): Map<string, string> {
  const byInitials = new Map<string, { id: string; name: string }[]>();
  for (const p of [...people].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = initialsOf(p.name) || "?";
    byInitials.set(key, [...(byInitials.get(key) ?? []), p]);
  }
  const out = new Map<string, string>();
  for (const [key, list] of byInitials) {
    list.forEach((p, i) => {
      out.set(p.id, list.length > 1 ? `${key}${i + 1}` : key);
    });
  }
  return out;
}

const timeOf = (instant: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);

/** "BST" or "GMT" after a time on a clock-change day, so a repeated hour is never ambiguous. */
const zoneOnChangeDay = (instant: Date) => {
  const m = /\s(BST|GMT)$/.exec(ukDateTime(instant));
  return m ? ` ${m[1]}` : "";
};

function recordWords(r: MarRecord, input: Pick<MarPrintInput, "staff">): string[] {
  const who = r.by ? input.staff(r.by)?.initials : null;
  return [
    MAR_OUTCOME_CODES[r.outcome],
    r.amount,
    r.reason ? `(${r.reason})` : null,
    r.covert ? "covert" : null,
    r.corrected ? "corrected" : null,
    who ?? "giver not named",
  ].filter((v): v is string => Boolean(v));
}

/**
 * One dose's cell: its time and outcome code, with the time given when it differs from the time
 * due, the amount, the reason, covert and corrected marks and the giver's initials.
 */
export function doseCell(
  cell: MarDoseCell,
  input: Pick<MarPrintInput, "staff" | "printedAt">,
): string {
  const time = `${cell.time}${zoneOnChangeDay(cell.dueAt)}`;
  if (cell.notDue) return `${time} not due (before the entry was recorded)`;
  const r = cell.record;
  if (!r) {
    return cell.dueAt.getTime() <= input.printedAt.getTime()
      ? `${time} no outcome recorded`
      : `${time} not yet due`;
  }
  const given = timeOf(r.givenAt);
  const sameDay = ukDate(r.givenAt) === ukDate(cell.dueAt);
  const at =
    given === cell.time && sameDay
      ? null
      : `at ${sameDay ? given : ukDateTime(r.givenAt)}${sameDay ? zoneOnChangeDay(r.givenAt) : ""}`;
  return [time, ...recordWords(r, input).slice(0, 1), at, ...recordWords(r, input).slice(1)]
    .filter(Boolean)
    .join(" ");
}

function allergyLines(a: AllergyStatement): string[] {
  if (a.status === "has_allergies") {
    if (a.allergies.length === 0)
      return ["Allergies recorded, but none is listed. Check the record."];
    const order = ["severe", "unknown", "moderate", "mild"];
    return [...a.allergies]
      .sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity))
      .map(
        (x) =>
          `${x.substance}, severity ${x.severity}${x.reaction ? `, reaction: ${x.reaction}` : ""}`,
      );
  }
  if (a.status === "no_known_allergies") {
    return [`No known allergies${a.recordedAt ? `, recorded ${ukDateTime(a.recordedAt)}` : ""}.`];
  }
  return ["Allergy status not recorded. Find out before giving any medicine."];
}

export function communicationLines(c: CommunicationStatement): string[] {
  if (c.status === "recorded") {
    return c.needs.map((n) => `${n.display}${n.preferredFormat ? ` (${n.preferredFormat})` : ""}`);
  }
  if (c.status === "none_identified") return ["No communication needs identified."];
  return ["Communication needs not recorded. Ask the person or their family."];
}

/** Doses grouped by UK date, in date order. */
function byDate(doses: readonly MarDoseCell[]): [string, MarDoseCell[]][] {
  const groups = new Map<string, MarDoseCell[]>();
  for (const d of [...doses].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())) {
    const list = groups.get(d.date) ?? [];
    list.push(d);
    groups.set(d.date, list);
  }
  return [...groups.entries()];
}

/** The person's identity as printed on every page (HZ-001). */
export function marIdentity(person: MarPrintInput["person"]): string {
  return `${person.name}${person.preferredName ? ` (known as ${person.preferredName})` : ""}. Born ${ukDate(
    person.dateOfBirth,
  )}. NHS number ${person.nhsNumber ? formatNhsNumber(person.nhsNumber) : "not recorded"}. ${person.locationName}.`;
}

/** Every line of the chart, in order: the PDF draws them, and tests read them. */
export function marChartLines(input: MarPrintInput): PdfLine[] {
  const owner = input.person.name;
  const lines: PdfLine[] = [
    { text: `MAR chart for ${input.month.label}`, bold: true, size: 14, owner },
    { text: marPrintedNotice(input.printedAt), bold: true },
    { text: marIdentity(input.person) },
    { text: "Allergies", bold: true, gapBefore: 8 },
    ...allergyLines(input.allergies).map((text) => ({ text })),
    { text: "Communication needs", bold: true, gapBefore: 8 },
    ...communicationLines(input.communication).map((text) => ({ text })),
    { text: "Key to the codes", bold: true, gapBefore: 8 },
    ...(Object.keys(MAR_OUTCOME_CODES) as MarOutcome[]).map((o) => ({
      text: `${MAR_OUTCOME_CODES[o]}: ${OUTCOME_WORDS[o]}`,
    })),
    { text: '"at" and a time: when it was given, if not at the time due.' },
    { text: '"covert": given covertly under the person\'s covert administration record.' },
    { text: '"corrected": this record corrects an earlier one. The eMAR history shows both.' },
    {
      text: "The letters at the end are the initials of who gave it. They are listed at the end of the chart.",
    },
  ];
  if (input.entries.length === 0) {
    lines.push({ text: "No medicine was on the eMAR this month.", gapBefore: 8 });
  }
  const used = new Set<string>();
  const note = (r: MarRecord) => {
    if (r.by) used.add(r.by);
  };
  for (const entry of input.entries) {
    lines.push({
      text: `${entry.timeCritical ? "Time-critical: " : ""}${entry.productName}, ${entry.route} (version ${entry.version})`,
      bold: true,
      gapBefore: 10,
    });
    lines.push({ text: entry.directions });
    lines.push({
      text: `Prescriber ${entry.prescriber}. Starts ${ukDateTime(entry.startsAt)}${
        entry.endsAt ? `, ends ${ukDateTime(entry.endsAt)}` : ""
      }. Status on the eMAR when printed: ${entry.status}.`,
    });
    if (entry.kind === "regular") {
      const days = byDate(entry.doses);
      if (days.length === 0) lines.push({ text: "No dose was due this month." });
      for (const [date, cells] of days) {
        for (const c of cells) if (c.record) note(c.record);
        lines.push({
          text: `${cells[0]?.dayName ?? ""} ${ukDate(date)}: ${cells.map((c) => doseCell(c, input)).join("; ")}`,
        });
      }
      for (const r of entry.unmatched) {
        note(r);
        lines.push({
          text: `Recorded with no dose time on this chart: ${ukDateTime(r.givenAt)} ${recordWords(r, input).join(" ")}`,
        });
      }
    } else if (entry.prnRecords.length === 0) {
      lines.push({ text: "No dose recorded this month." });
    } else {
      for (const r of entry.prnRecords) {
        note(r);
        lines.push({ text: `${ukDateTime(r.givenAt)} ${recordWords(r, input).join(" ")}` });
      }
    }
  }
  const staff = [...used]
    .map((id) => input.staff(id))
    .filter((s): s is { name: string; initials: string } => s !== null)
    .sort((a, b) => a.initials.localeCompare(b.initials));
  if (staff.length > 0) {
    lines.push({ text: "Staff initials on this chart", bold: true, gapBefore: 10 });
    for (const s of staff) lines.push({ text: `${s.initials}: ${s.name}` });
  }
  return lines;
}

/** The chart as a PDF: the person and the printed notice on every page (HZ-001, HZ-122). */
export function renderMarPdf(input: MarPrintInput): Uint8Array {
  return renderPdf({
    title: `MAR chart, ${input.month.label}`,
    header: [
      `MAR chart for ${input.month.label}. ${marIdentity(input.person)}`,
      marPrintedNotice(input.printedAt),
    ],
    lines: marChartLines(input),
    footer: (page, pages) =>
      `${input.person.name}, MAR chart for ${input.month.label}. Page ${page} of ${pages}`,
  });
}

const OUTCOMES: ReadonlySet<string> = new Set(Object.keys(MAR_OUTCOME_CODES));

/** The unit's name for an amount recorded in the entry's own unit; "unit" and the code otherwise. */
function unitName(entry: MarEntry, unitCode: string | null): string {
  const d = entry.directions;
  const dose = d.kind === "when_required" ? d.dose : d.schedule.times[0]?.dose;
  if (dose && dose.unit.code === unitCode) return dose.unit.name;
  return unitCode ? `(unit ${unitCode})` : "";
}

function toRecord(r: AdministrationRow, entry: MarEntry): MarRecord {
  return {
    outcome: r.outcome as MarOutcome,
    givenAt: r.givenAt,
    by: r.administeredBy,
    covert: r.covert,
    corrected: r.supersedesId !== null,
    amount:
      r.quantity !== null
        ? `${formatDoseQuantity(Number(r.quantity))} ${unitName(entry, r.unitCode)}`.trim()
        : null,
    reason: r.reasonCode
      ? [REASON_WORDS[r.reasonCode] ?? r.reasonCode, r.reasonNote].filter(Boolean).join(": ")
      : r.reasonNote,
  };
}

const inWindow = (at: Date | null, w: { from: Date; to: Date }) =>
  at !== null && at.getTime() >= w.from.getTime() && at.getTime() < w.to.getTime();

/**
 * The chart's medicines from the person's entries and their records that stand (`effective`,
 * worked out over all their records, so a correction in another month still supersedes): a
 * scheduled dose by its due time in the month, a when-required dose by when it was given. A record
 * of a scheduled dose that matches no dose time on the chart is printed, never dropped
 * (clinical review of slice 50, B1 and B2).
 */
export function marPrintEntries(
  entries: readonly MarEntry[],
  standing: readonly AdministrationRow[],
  window: { readonly from: Date; readonly to: Date },
  printedAt: Date,
): MarPrintEntry[] {
  const rows = standing.filter((r) => OUTCOMES.has(r.outcome));
  return entries.flatMap((entry) => {
    const mine = rows.filter((r) => r.medicationId === entry.id);
    const regular = entry.directions.kind === "regular";
    const dueTimes = regular
      ? [
          ...marEntryDoses(entry, window).map((d) => ({ d, notDue: false })),
          ...marEntryTimesBeforeRecorded(entry, window).map((d) => ({ d, notDue: true })),
        ]
      : [];
    const matched = new Set<string>();
    const doses: MarDoseCell[] = dueTimes.map(({ d, notDue }) => {
      const r = mine.find((x) => x.dueAt?.getTime() === d.dueAt.getTime());
      if (r) matched.add(r.id);
      return {
        dueAt: d.dueAt,
        date: d.date,
        time: d.time,
        dayName:
          d.dayName ??
          new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" }).format(
            d.dueAt,
          ),
        notDue,
        record: r ? toRecord(r, entry) : null,
      };
    });
    const unmatched = regular
      ? mine
          .filter((r) => !matched.has(r.id) && inWindow(r.dueAt ?? r.givenAt, window))
          .map((r) => toRecord(r, entry))
      : [];
    const prnRecords = regular
      ? []
      : mine.filter((r) => inWindow(r.givenAt, window)).map((r) => toRecord(r, entry));
    const end = marEntryEnd(entry);
    const inMonth =
      entry.startsAt.getTime() < window.to.getTime() &&
      (end === null || end.getTime() > window.from.getTime());
    if (
      doses.length === 0 &&
      prnRecords.length === 0 &&
      unmatched.length === 0 &&
      (!inMonth || entry.withdrawn)
    ) {
      return [];
    }
    return [
      {
        productName: entry.product.name,
        version: entry.version,
        route: entry.route.name,
        directions: directionsInWords(entry),
        kind: regular ? ("regular" as const) : ("when_required" as const),
        startsAt: entry.startsAt,
        endsAt: end,
        prescriber: entry.prescriber,
        status: marEntryStatus(entry, printedAt, UNCHECKED_POLICY).words,
        timeCritical: isTimeCritical(entry),
        doses,
        prnRecords,
        unmatched,
      },
    ];
  });
}
