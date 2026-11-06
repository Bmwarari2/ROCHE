import type { AllergyStatement } from "@harbour/domain";
import { formatNhsNumber, formatUkDateTimeWithZone } from "@harbour/domain";
import { type PdfLine, renderPdf } from "./pdf";
import { ukDate, ukDateTime } from "./transfer-pack-pdf";

/**
 * The printable MAR chart (Phase 2 slice 50; MEDS-014; medicines.md section 17): one person, one
 * calendar month, from the eMAR. It shows:
 * - the person on every page;
 * - the allergy section (HZ-007);
 * - each medicine with its directions and every dose of the month by day, with its outcome as a
 *   code, the initials of who gave it, covert marks and corrections;
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
  refused: "refused",
  omitted: "not given",
  withheld: "withheld",
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
  /** The amount given in words, for a when-required dose ("15 ml"). */
  readonly amount: string | null;
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
  readonly route: string;
  readonly directions: string;
  readonly kind: "regular" | "when_required";
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly prescriber: string;
  /** The entry's status now, in words ("Checked", "Not yet checked", "Stopped"). */
  readonly status: string;
  readonly timeCritical: boolean;
  readonly doses: readonly MarDoseCell[];
  /** When-required doses recorded in the month, oldest first. */
  readonly prnRecords: readonly MarRecord[];
}

export interface MarPrintInput {
  readonly person: {
    readonly name: string;
    readonly dateOfBirth: string | null;
    readonly nhsNumber: string | null;
    readonly room: string | null;
    readonly locationName: string;
  };
  /** The month as "November 2026", and its UK start (inclusive) and end (exclusive). */
  readonly month: { readonly label: string; readonly from: Date; readonly to: Date };
  readonly allergies: AllergyStatement;
  readonly entries: readonly MarPrintEntry[];
  /** Staff initials and names by id, for the cells and the key. */
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

/** One dose's cell: its time and outcome code, with covert, corrected and the giver's initials. */
export function doseCell(
  cell: MarDoseCell,
  input: Pick<MarPrintInput, "staff" | "printedAt">,
): string {
  if (cell.notDue) return `${cell.time} not due (before the entry was recorded)`;
  const r = cell.record;
  if (!r) {
    return cell.dueAt.getTime() <= input.printedAt.getTime()
      ? `${cell.time} no outcome recorded`
      : `${cell.time} not yet due`;
  }
  const who = input.staff(r.by)?.initials;
  return [
    `${cell.time} ${MAR_OUTCOME_CODES[r.outcome]}`,
    r.covert ? "covert" : null,
    r.corrected ? "corrected" : null,
    who ?? null,
  ]
    .filter(Boolean)
    .join(" ");
}

function allergyLines(a: AllergyStatement): string[] {
  if (a.status === "has_allergies") {
    if (a.allergies.length === 0)
      return ["Allergies recorded, but none is listed. Check the record."];
    const order = ["life_threatening", "severe", "unknown", "moderate", "mild"];
    return [...a.allergies]
      .sort((x, y) => order.indexOf(x.severity) - order.indexOf(y.severity))
      .map(
        (x) =>
          `${x.substance}, severity ${x.severity.replaceAll("_", " ")}${x.reaction ? `, reaction: ${x.reaction}` : ""}`,
      );
  }
  if (a.status === "no_known_allergies") {
    return [`No known allergies${a.recordedAt ? `, recorded ${ukDateTime(a.recordedAt)}` : ""}.`];
  }
  return ["Allergy status not recorded. Find out before giving any medicine."];
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

/** Every line of the chart, in order: the PDF draws them, and tests read them. */
export function marChartLines(input: MarPrintInput): PdfLine[] {
  const owner = input.person.name;
  const lines: PdfLine[] = [
    { text: `MAR chart for ${input.month.label}`, bold: true, size: 14, owner },
    { text: marPrintedNotice(input.printedAt), bold: true },
    {
      text: `${input.person.name}. Born ${ukDate(input.person.dateOfBirth)}. NHS number ${
        input.person.nhsNumber ? formatNhsNumber(input.person.nhsNumber) : "not recorded"
      }. ${input.person.room ? `Room ${input.person.room}, ` : ""}${input.person.locationName}.`,
    },
    { text: "Allergies", bold: true, gapBefore: 8 },
    ...allergyLines(input.allergies).map((text) => ({ text })),
    { text: "Key to the codes", bold: true, gapBefore: 8 },
    {
      text: (Object.keys(MAR_OUTCOME_CODES) as MarOutcome[])
        .map((o) => `${MAR_OUTCOME_CODES[o]} ${OUTCOME_WORDS[o]}`)
        .join("; "),
    },
    {
      text: '"covert": given covertly under the person\'s covert administration record. "corrected": this record corrects an earlier one; the eMAR history shows both. Letters after a code are the initials of who gave it.',
    },
  ];
  if (input.entries.length === 0) {
    lines.push({ text: "No medicine was on the eMAR this month.", gapBefore: 8 });
  }
  const used = new Set<string>();
  for (const entry of input.entries) {
    lines.push({
      text: `${entry.timeCritical ? "Time-critical: " : ""}${entry.productName}, ${entry.route}`,
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
        for (const c of cells) if (c.record?.by) used.add(c.record.by);
        lines.push({
          text: `${cells[0]?.dayName ?? ""} ${ukDate(date)}: ${cells.map((c) => doseCell(c, input)).join("; ")}`,
        });
      }
    } else if (entry.prnRecords.length === 0) {
      lines.push({ text: "No dose recorded this month." });
    } else {
      for (const r of entry.prnRecords) {
        if (r.by) used.add(r.by);
        const who = input.staff(r.by)?.initials;
        lines.push({
          text: [
            `${ukDateTime(r.givenAt)} ${MAR_OUTCOME_CODES[r.outcome]}`,
            r.amount,
            r.covert ? "covert" : null,
            r.corrected ? "corrected" : null,
            who ?? null,
          ]
            .filter(Boolean)
            .join(" "),
        });
      }
    }
  }
  const staff = [...used]
    .map((id) => input.staff(id))
    .filter((s): s is { name: string; initials: string } => s !== null)
    .sort((a, b) => a.initials.localeCompare(b.initials));
  if (staff.length > 0) {
    lines.push({ text: "Staff initials on this chart", bold: true, gapBefore: 10 });
    lines.push({ text: staff.map((s) => `${s.initials} ${s.name}`).join("; ") });
  }
  return lines;
}

/** The chart as a PDF: the person and the printed notice on every page (HZ-001, HZ-122). */
export function renderMarPdf(input: MarPrintInput): Uint8Array {
  return renderPdf({
    title: `MAR chart, ${input.month.label}`,
    header: [
      `${input.person.name}, MAR chart for ${input.month.label}`,
      marPrintedNotice(input.printedAt),
    ],
    lines: marChartLines(input),
    footer: (page, pages) =>
      `${input.person.name}, MAR chart for ${input.month.label}. Page ${page} of ${pages}`,
  });
}
