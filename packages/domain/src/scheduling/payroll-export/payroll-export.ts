import { MINUTES_PER_HOUR } from "../intervals";
import { PENCE_PER_POUND } from "../pay/money";

/**
 * Payroll and pension exports (scheduling.md section 19; SCHED-008; ADR-0013, ADR-0097). This
 * builds what leaves Harbour for a locked pay run, in each provider's format, from the run's own
 * figures. It is pure and deterministic: the same lines and format always give the same text, so
 * an export can be checked against its record (rule 5). It holds no statutory figure, only the
 * units of money and time. The layouts are to verify with each provider (H-1191).
 */

export const PAYROLL_FORMATS = [
  "xero_payroll_uk",
  "staffology_csv",
  "sage_csv",
  "brightpay_csv",
] as const;
export type PayrollFormat = (typeof PAYROLL_FORMATS)[number];
export const FILE_FORMATS: readonly PayrollFormat[] = [
  "staffology_csv",
  "sage_csv",
  "brightpay_csv",
];

/** The version of each format's layout; bumped when a layout changes, recorded on each export. */
export const PAYROLL_FORMAT_VERSIONS: Readonly<Record<PayrollFormat, number>> = {
  xero_payroll_uk: 1,
  staffology_csv: 1,
  sage_csv: 1,
  brightpay_csv: 1,
};

export type ExportAeCategory =
  | "eligible_jobholder"
  | "non_eligible_jobholder"
  | "entitled_worker"
  | "outside_age_range";

/** One locked line as it may leave (rule 4): no name, date of birth, NI number, bank or working. */
export interface ExportLine {
  readonly memberId: string;
  /** The organisation's own works number or the provider's employee id; null blocks the export. */
  readonly payrollReference: string | null;
  readonly paidMinutes: number;
  readonly basicPence: number;
  readonly premiumPence: number;
  readonly sleepInPence: number;
  readonly onCallPence: number;
  readonly mileagePence: number;
  readonly nmwTopUpPence: number;
  readonly rolledUpHolidayPence: number;
  readonly sspPence: number;
  readonly totalPence: number;
  readonly holidayAccruedMinutes: number | null;
  readonly aeCategory: ExportAeCategory | null;
  readonly qualifyingEarningsPence: number | null;
}

export interface ExportRun {
  readonly id: string;
  readonly frequency: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/** The pay elements, in the order every format lists them, each with its own code. */
export const PAY_ELEMENTS = [
  { key: "basicPence", code: "BASIC", label: "Basic pay" },
  { key: "premiumPence", code: "PREMIUM", label: "Premiums" },
  { key: "sleepInPence", code: "SLEEPIN", label: "Sleep-ins" },
  { key: "onCallPence", code: "ONCALL", label: "On-call" },
  { key: "mileagePence", code: "MILEAGE", label: "Mileage" },
  { key: "nmwTopUpPence", code: "NMWTOPUP", label: "Minimum wage top-up" },
  { key: "rolledUpHolidayPence", code: "HOLIDAY", label: "Rolled-up holiday pay" },
  { key: "sspPence", code: "SSP", label: "Statutory sick pay" },
] as const satisfies readonly { key: keyof ExportLine; code: string; label: string }[];

export type ExportProblem = {
  readonly code: "payroll_reference_missing";
  readonly memberIds: string[];
};

/** Pence as pounds with two decimals and no symbol or separator: "1234.56", "-0.05", "0.00". */
export function poundsText(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / PENCE_PER_POUND);
  const rest = String(abs % PENCE_PER_POUND).padStart(String(PENCE_PER_POUND).length - 1, "0");
  return `${sign}${pounds}.${rest}`;
}

/** Minutes as hours with two decimals: 450 minutes is "7.50". */
export function hoursText(minutes: number): string {
  return poundsText(Math.round((minutes * PENCE_PER_POUND) / MINUTES_PER_HOUR));
}

/**
 * One CSV cell: always quoted, quotes doubled, and a leading =, +, -, @, tab or carriage return
 * prefixed with an apostrophe so a spreadsheet never runs it as a formula (rule 7). Numbers are
 * written by `poundsText`, so a negative figure is never mistaken for one.
 */
export function payrollCsvCell(value: string, numeric = false): string {
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

const row = (cells: readonly { v: string; n?: boolean }[]) =>
  cells.map((c) => payrollCsvCell(c.v, c.n === true)).join(",");

const text = (v: string) => ({ v });
const num = (v: string) => ({ v, n: true });

type Layout = (run: ExportRun, lines: readonly ExportLine[]) => string[];

/** Staffology: one row per pay element per employee, as its pay element import (to verify). */
const staffology: Layout = (run, lines) => {
  const out = [row(["Payroll Code", "Pay Code", "Value", "Period Start", "Period End"].map(text))];
  for (const l of lines) {
    for (const e of PAY_ELEMENTS) {
      out.push(
        row([
          text(l.payrollReference ?? ""),
          text(e.code),
          num(poundsText(l[e.key])),
          text(run.periodStart),
          text(run.periodEnd),
        ]),
      );
    }
    out.push(
      row([
        text(l.payrollReference ?? ""),
        text("HOURS"),
        num(hoursText(l.paidMinutes)),
        text(run.periodStart),
        text(run.periodEnd),
      ]),
    );
    out.push(
      row([
        text(l.payrollReference ?? ""),
        text("AE_CATEGORY"),
        text(l.aeCategory ?? ""),
        text(run.periodStart),
        text(run.periodEnd),
      ]),
    );
    out.push(
      row([
        text(l.payrollReference ?? ""),
        text("AE_QUALIFYING_EARNINGS"),
        num(l.qualifyingEarningsPence === null ? "" : poundsText(l.qualifyingEarningsPence)),
        text(run.periodStart),
        text(run.periodEnd),
      ]),
    );
  }
  return out;
};

/** Sage Payroll: one row per payment per employee reference, as its payments import (to verify). */
const sage: Layout = (_run, lines) => {
  const out = [row(["Reference", "Payment", "Units", "Amount"].map(text))];
  for (const l of lines) {
    out.push(
      row([text(l.payrollReference ?? ""), text("Hours"), num(hoursText(l.paidMinutes)), num("")]),
    );
    for (const e of PAY_ELEMENTS) {
      out.push(
        row([text(l.payrollReference ?? ""), text(e.label), num(""), num(poundsText(l[e.key]))]),
      );
    }
  }
  return out;
};

/** BrightPay: one row per employee, a column per element, as its hours and pay import (to verify). */
const brightpay: Layout = (_run, lines) => {
  const header = [
    "Employee ID",
    "Hours",
    ...PAY_ELEMENTS.map((e) => e.label),
    "Total",
    "Holiday accrued hours",
    "Auto-enrolment category",
    "Qualifying earnings",
  ];
  const out = [row(header.map(text))];
  for (const l of lines) {
    out.push(
      row([
        text(l.payrollReference ?? ""),
        num(hoursText(l.paidMinutes)),
        ...PAY_ELEMENTS.map((e) => num(poundsText(l[e.key]))),
        num(poundsText(l.totalPence)),
        num(l.holidayAccruedMinutes === null ? "" : hoursText(l.holidayAccruedMinutes)),
        text(l.aeCategory ?? ""),
        num(l.qualifyingEarningsPence === null ? "" : poundsText(l.qualifyingEarningsPence)),
      ]),
    );
  }
  return out;
};

const LAYOUTS: Readonly<Record<Exclude<PayrollFormat, "xero_payroll_uk">, Layout>> = {
  staffology_csv: staffology,
  sage_csv: sage,
  brightpay_csv: brightpay,
};

/** Plain code-unit order: never a locale's, which can change with the runtime (rule 5). */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Lines in the order every format uses: by payroll reference, then member id (rule 5). */
export function orderedLines(lines: readonly ExportLine[]): ExportLine[] {
  return [...lines].sort(
    (a, b) =>
      byCodeUnit(a.payrollReference ?? "", b.payrollReference ?? "") ||
      byCodeUnit(a.memberId, b.memberId),
  );
}

/** Rule 3: every line names its member by payroll reference, or the export is refused. */
export function checkExportLines(lines: readonly ExportLine[]): ExportProblem | null {
  const missing = lines.filter((l) => !l.payrollReference?.trim()).map((l) => l.memberId);
  return missing.length > 0
    ? { code: "payroll_reference_missing", memberIds: [...missing].sort() }
    : null;
}

export interface BuiltFile {
  readonly fileName: string;
  readonly contentType: "text/csv; charset=utf-8";
  /** CRLF line endings and a final CRLF, as CSV (RFC 4180) has them. */
  readonly content: string;
  readonly lineCount: number;
}

/** A file export of a locked run (rules 4, 5 and 7): deterministic for the same run and lines. */
export function buildPayrollFile(
  format: Exclude<PayrollFormat, "xero_payroll_uk">,
  run: ExportRun,
  lines: readonly ExportLine[],
): BuiltFile | ExportProblem {
  const problem = checkExportLines(lines);
  if (problem) return problem;
  const rows = LAYOUTS[format](run, orderedLines(lines));
  return {
    fileName: `pay-run-${run.periodStart}-to-${run.periodEnd}-${format.replace("_csv", "")}-v${PAYROLL_FORMAT_VERSIONS[format]}.csv`,
    contentType: "text/csv; charset=utf-8",
    content: `${rows.join("\r\n")}\r\n`,
    lineCount: lines.length,
  };
}

/** What the Xero Payroll UK adapter sends (rule 8): one batch of earnings and hours per employee. */
export interface XeroPayBatch {
  readonly payRunId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly employees: readonly {
    readonly employeeId: string;
    readonly hours: string;
    readonly earnings: readonly { readonly code: string; readonly amount: string }[];
    readonly autoEnrolment: {
      readonly category: string | null;
      readonly qualifyingEarnings: string | null;
    };
  }[];
}

export function buildXeroBatch(
  run: ExportRun,
  lines: readonly ExportLine[],
): XeroPayBatch | ExportProblem {
  const problem = checkExportLines(lines);
  if (problem) return problem;
  return {
    payRunId: run.id,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    employees: orderedLines(lines).map((l) => ({
      employeeId: l.payrollReference as string,
      hours: hoursText(l.paidMinutes),
      earnings: PAY_ELEMENTS.filter((e) => l[e.key] !== 0).map((e) => ({
        code: e.code,
        amount: poundsText(l[e.key]),
      })),
      autoEnrolment: {
        category: l.aeCategory,
        qualifyingEarnings:
          l.qualifyingEarningsPence === null ? null : poundsText(l.qualifyingEarningsPence),
      },
    })),
  };
}

export const isExportProblem = (v: unknown): v is ExportProblem =>
  typeof v === "object" &&
  v !== null &&
  (v as { code?: unknown }).code === "payroll_reference_missing";
