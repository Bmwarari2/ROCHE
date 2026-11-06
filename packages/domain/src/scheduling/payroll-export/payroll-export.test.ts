import { describe, expect, it } from "vitest";
import {
  buildPayrollFile,
  buildXeroBatch,
  type ExportLine,
  type ExportRun,
  hoursText,
  isExportProblem,
  orderedLines,
  payrollCsvCell,
  poundsText,
} from "./payroll-export";

/** Payroll and pension exports (scheduling.md section 19; SCHED-008), table-driven. */

const RUN: ExportRun = {
  id: "0199e076-0000-7000-8000-000000000001",
  frequency: "monthly",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
};
const line = (over: Partial<ExportLine> = {}): ExportLine => ({
  memberId: "0199e076-0000-7000-8000-0000000000a1",
  payrollReference: "W001",
  paidMinutes: 9600,
  basicPence: 192000,
  premiumPence: 4500,
  sleepInPence: 0,
  onCallPence: 0,
  mileagePence: 1250,
  nmwTopUpPence: 0,
  rolledUpHolidayPence: 0,
  sspPence: 0,
  totalPence: 197750,
  holidayAccruedMinutes: 1159,
  aeCategory: "eligible_jobholder",
  qualifyingEarningsPence: 72250,
  ...over,
});

describe("SCHED-008 rule 4 money and hours as they leave", () => {
  it.each<[number, string]>([
    [0, "0.00"],
    [5, "0.05"],
    [100, "1.00"],
    [123456, "1234.56"],
    [-5, "-0.05"],
    [-123456, "-1234.56"],
  ])("%i pence is %s", (pence, expected) => {
    expect(poundsText(pence)).toBe(expected);
  });
  it.each<[number, string]>([
    [0, "0.00"],
    [450, "7.50"],
    [9600, "160.00"],
    [1159, "19.32"],
  ])("%i minutes is %s hours", (minutes, expected) => {
    expect(hoursText(minutes)).toBe(expected);
  });
});

describe("SCHED-008 rule 7 cells never run as spreadsheet formulas", () => {
  it.each<[string, boolean, string]>([
    ["W001", false, '"W001"'],
    ['Say "hi"', false, '"Say ""hi"""'],
    ["=SUM(A1)", false, `"'=SUM(A1)"`],
    ["+44", false, `"'+44"`],
    ["@cmd", false, `"'@cmd"`],
    ["-1", false, `"'-1"`],
    ["-0.05", true, '"-0.05"'],
  ])("%s", (value, numeric, expected) => {
    expect(payrollCsvCell(value, numeric)).toBe(expected);
  });
});

describe("SCHED-008 rules 3 and 5 every line named, always in the same order", () => {
  it("refuses a run with a member without a payroll reference, naming them by id", () => {
    const out = buildPayrollFile("brightpay_csv", RUN, [
      line(),
      line({ memberId: "b", payrollReference: null }),
      line({ memberId: "a", payrollReference: " " }),
    ]);
    expect(isExportProblem(out)).toBe(true);
    expect(out).toEqual({ code: "payroll_reference_missing", memberIds: ["a", "b"] });
    expect(isExportProblem(buildXeroBatch(RUN, [line({ payrollReference: null })]))).toBe(true);
  });
  it("orders by payroll reference whatever order the lines came in", () => {
    const lines = [
      line({ payrollReference: "W010", memberId: "z" }),
      line({ payrollReference: "W002", memberId: "y" }),
    ];
    expect(orderedLines(lines).map((l) => l.payrollReference)).toEqual(["W002", "W010"]);
    const a = buildPayrollFile("sage_csv", RUN, lines);
    const b = buildPayrollFile("sage_csv", RUN, [...lines].reverse());
    expect(a).toEqual(b);
  });
  it("orders by code unit, never by a locale's rules", () => {
    const lines = [
      line({ payrollReference: "a10", memberId: "x" }),
      line({ payrollReference: "B10", memberId: "y" }),
      line({ payrollReference: "A10", memberId: "z" }),
    ];
    // A locale would put "a10" between "A10" and "B10"; code units put capitals first.
    expect(orderedLines(lines).map((l) => l.payrollReference)).toEqual(["A10", "B10", "a10"]);
  });
});

describe("SCHED-008 rules 4 and 7 the formats", () => {
  it("BrightPay: one row per member with the pension flags, never a name", () => {
    const out = buildPayrollFile("brightpay_csv", RUN, [line()]);
    if (isExportProblem(out)) throw new Error("refused");
    const [header, first] = out.content.split("\r\n");
    expect(header).toBe(
      '"Employee ID","Hours","Basic pay","Premiums","Sleep-ins","On-call","Mileage","Minimum wage top-up","Rolled-up holiday pay","Statutory sick pay","Total","Holiday accrued hours","Auto-enrolment category","Qualifying earnings"',
    );
    expect(first).toBe(
      '"W001","160.00","1920.00","45.00","0.00","0.00","12.50","0.00","0.00","0.00","1977.50","19.32","eligible_jobholder","722.50"',
    );
    expect(out.content.endsWith("\r\n")).toBe(true);
    expect(out.fileName).toBe("pay-run-2026-10-01-to-2026-10-31-brightpay-v1.csv");
    expect(out.lineCount).toBe(1);
  });
  it("Staffology: a row per element, hours and the pension flags", () => {
    const out = buildPayrollFile("staffology_csv", RUN, [line()]);
    if (isExportProblem(out)) throw new Error("refused");
    const rows = out.content.trim().split("\r\n");
    expect(rows[0]).toBe('"Payroll Code","Pay Code","Value","Period Start","Period End"');
    expect(rows).toContain('"W001","BASIC","1920.00","2026-10-01","2026-10-31"');
    expect(rows).toContain('"W001","HOURS","160.00","2026-10-01","2026-10-31"');
    expect(rows).toContain('"W001","AE_CATEGORY","eligible_jobholder","2026-10-01","2026-10-31"');
    expect(rows).toContain('"W001","AE_QUALIFYING_EARNINGS","722.50","2026-10-01","2026-10-31"');
    expect(rows).toHaveLength(1 + 8 + 3);
  });
  it("Sage: hours then a row per payment", () => {
    const out = buildPayrollFile("sage_csv", RUN, [
      line({ aeCategory: null, qualifyingEarningsPence: null }),
    ]);
    if (isExportProblem(out)) throw new Error("refused");
    const rows = out.content.trim().split("\r\n");
    expect(rows[0]).toBe('"Reference","Payment","Units","Amount"');
    expect(rows[1]).toBe('"W001","Hours","160.00",""');
    expect(rows[2]).toBe('"W001","Basic pay","","1920.00"');
  });
  it("Xero: earnings only for elements with a figure, with the pension flags", () => {
    const out = buildXeroBatch(RUN, [line()]);
    if (isExportProblem(out)) throw new Error("refused");
    expect(out.employees[0]).toEqual({
      employeeId: "W001",
      hours: "160.00",
      earnings: [
        { code: "BASIC", amount: "1920.00" },
        { code: "PREMIUM", amount: "45.00" },
        { code: "MILEAGE", amount: "12.50" },
      ],
      autoEnrolment: { category: "eligible_jobholder", qualifyingEarnings: "722.50" },
    });
  });
  it("keeps a member id out of every file", () => {
    for (const format of ["staffology_csv", "sage_csv", "brightpay_csv"] as const) {
      const out = buildPayrollFile(format, RUN, [line()]);
      if (isExportProblem(out)) throw new Error("refused");
      expect(out.content).not.toContain(line().memberId);
    }
  });
});
