import type { RetentionReportCounts } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import { classWords, dueCounts, dueRows, dueView } from "./retention-report";

const ZERO: RetentionReportCounts = {
  due: 0,
  held: 0,
  retain: 0,
  no_trigger_yet: 0,
  tenant_policy: 0,
  never_offered: 0,
  not_evaluated: 0,
};
const counts = (c: Partial<RetentionReportCounts>) => ({ ...ZERO, ...c });
const line = (table: string, recordClass: string | null, c: Partial<RetentionReportCounts>) => ({
  table,
  recordClass,
  reason: recordClass ? null : "follows_parent",
  counts: counts(c),
});
const REPORT = {
  id: "0194d000-0000-7000-8000-0000000000aa",
  asOf: "2026-11-08T02:29:00.000Z",
  durationMs: 1200,
  tablesRead: 2,
  tablesSkipped: 1,
  totals: ZERO,
  lines: [],
};

describe("retention report screen (retention sweeps slice 5)", () => {
  it.each([
    [{ mode: "off" as const, report: null }, "off"],
    // A report kept from when it was on is not shown as current once it is off.
    [{ mode: "off" as const, report: REPORT }, "off"],
    [{ mode: "report" as const, report: null }, "waiting"],
    [{ mode: "report" as const, report: REPORT }, "report"],
  ])("%o is %s", (due, kind) => {
    expect(dueView(due).kind).toBe(kind);
  });

  it("folds the seven counts into the screen's columns, with a total", () => {
    expect(
      dueCounts({
        due: 1,
        held: 2,
        retain: 3,
        no_trigger_yet: 4,
        tenant_policy: 5,
        never_offered: 6,
        not_evaluated: 7,
      }),
    ).toEqual({ due: 1, held: 2, notYetDue: 7, neverOffered: 11, notEvaluated: 7, total: 28 });
  });

  it("adds up each kind across tables, most due first, unread tables last", () => {
    const rows = dueRows([
      line("incident_person", null, { not_evaluated: 9 }),
      line("care_note", "care_record", { due: 2, retain: 5 }),
      line("training", "training_record", { due: 4 }),
      line("care_plan", "care_record", { due: 3, held: 1 }),
      line("complaint", "complaint", { no_trigger_yet: 2 }),
      line("candour_record", null, { never_offered: 1 }),
    ]);
    expect(rows.map((r) => r.recordClass)).toEqual([
      "care_record",
      "training_record",
      "complaint",
      null,
    ]);
    expect(rows[0]?.counts).toEqual({
      due: 5,
      held: 1,
      notYetDue: 5,
      neverOffered: 0,
      notEvaluated: 0,
      total: 11,
    });
    expect(rows[3]?.counts.total).toBe(10);
  });

  it.each([
    ["care_record", "Care records"],
    ["staff_file.after_leaving", "Staff files, kept from leaving"],
    ["staff_file,rota_and_timesheet", "Staff files; Rotas and timesheets"],
    ["something_new", "Records of class something_new"],
    [null, "Not read by kind yet"],
  ])("names %s in words", (recordClass, words) => {
    expect(classWords(recordClass, t)).toBe(words);
  });
});
