import { describe, expect, it } from "vitest";
import { RETENTION_REGISTRY } from "./retention-registry";
import {
  AS_PARENT,
  asLinked,
  byValue,
  classes,
  col,
  derived,
  entry,
  firstOf,
  lookup,
  NO_SUBJECT,
  PERMANENT,
  person,
  personRecord,
  rowClass,
  staff,
  WHILE_CURRENT,
} from "./retention-registry/registry";
import {
  countsByClass,
  emptyCounts,
  groupStatus,
  type ReportGroup,
  type ReportLine,
  type ReportPlan,
  reportPlan,
  reportTotals,
  tally,
} from "./retention-report";
import type { RetentionClassRow, SweepRules } from "./retention-sweep";

/*
 * Fixtures only: a few schedule rows standing in for the seeded `retention_class` table (the code
 * under test holds no period).
 */
const ROWS: readonly RetentionClassRow[] = [
  ["care_record", 8, "years", "care_ended"],
  ["complaint", 10, "years", "record_closed"],
  ["staff_file.after_leaving", 6, "years", "employment_ended_or_75th_birthday"],
  ["staff_file.to_75th_birthday", 0, "years", "employment_ended_or_75th_birthday"],
  ["rota_and_timesheet", 6, "years", "created"],
  ["controlled_drugs_register", 2, "years", "last_entry"],
  ["cctv", 0, "months", "tenant_policy"],
].map(([recordClass, period, unit, trigger]) => ({
  tenantId: null,
  recordClass: recordClass as string,
  period: period as number,
  unit: unit as string,
  trigger: trigger as string,
}));
const rules: SweepRules = {
  rows: ROWS,
  tenant: { tenantId: "00000000-0000-4000-8000-00000000000a", staffFileOption: null },
  staffFileBirthdayAge: 75,
};

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const NOW = d("2030-06-01");

const group = (extra: Partial<ReportGroup> = {}): ReportGroup => ({
  recordClass: null,
  held: false,
  receivingCare: false,
  careEnded: null,
  entryDate: null,
  closedAt: null,
  employmentEndedAt: null,
  dateOfBirth: null,
  createdAt: null,
  periodEndsAt: null,
  count: 1,
  ...extra,
});

const read = (e: Parameters<typeof reportPlan>[0]) => {
  const plan = reportPlan(e);
  if (plan.kind !== "read") throw new Error(`expected a read plan, got ${plan.reason}`);
  return plan;
};

describe("reportPlan", () => {
  const cases: readonly [string, Parameters<typeof reportPlan>[0], Partial<ReportPlan>][] = [
    [
      "configuration is never offered",
      entry("t", WHILE_CURRENT, {}, NO_SUBJECT, { method: { kind: "never" } }),
      { kind: "skip", status: "never_offered", reason: "kept_while_current" },
    ],
    [
      "proof is never offered",
      entry("t", PERMANENT, {}, NO_SUBJECT, { method: { kind: "never" } }),
      { kind: "skip", status: "never_offered", reason: "kept_permanently" },
    ],
    [
      "rows another sweep removes are never offered",
      entry(
        "t",
        { kind: "not_retained", removedBy: "x", rateKey: null, at: col("expires_at") },
        {},
        NO_SUBJECT,
      ),
      { kind: "skip", status: "never_offered", reason: "removed_by_other_sweep" },
    ],
    [
      "a child is not yet evaluated",
      entry("t", AS_PARENT, {}, NO_SUBJECT, { parent: { table: "p", column: "p_id" } }),
      { kind: "skip", status: "not_evaluated", reason: "follows_parent" },
    ],
    [
      "a link is not yet evaluated",
      entry("t", asLinked("subject_type", "subject_id"), {}, NO_SUBJECT),
      { kind: "skip", status: "not_evaluated", reason: "follows_linked_record" },
    ],
    [
      "a class by value is not yet evaluated",
      entry("t", byValue("kind", { a: ["complaint"] }), {}, NO_SUBJECT),
      { kind: "skip", status: "not_evaluated", reason: "class_by_value" },
    ],
    [
      "a derived date is not yet evaluated",
      entry("t", classes("complaint"), { closedAt: derived("rule", "a") }, NO_SUBJECT),
      { kind: "skip", status: "not_evaluated", reason: "date_not_readable_yet" },
    ],
    [
      "a sign-in table is outside the tenant tables",
      entry("auth.session", classes("complaint"), {}, NO_SUBJECT),
      { kind: "skip", status: "not_evaluated", reason: "outside_tenant_tables" },
    ],
  ];
  it.each(cases)("%s", (_name, e, expected) => {
    expect(reportPlan(e)).toEqual(expected);
  });

  it("reads fixed classes, a row's class column and the person column", () => {
    expect(read(personRecord("care_note", "care_record"))).toEqual({
      kind: "read",
      classColumn: null,
      classes: ["care_record"],
      facts: { careEnded: { from: "person_care_ended", column: "person_id" } },
      personColumn: "person_id",
    });
    const own = read(
      entry(
        "t",
        rowClass("retention_class", "complaint", "cctv"),
        { closedAt: firstOf("closed_at", "withdrawn_at"), createdAt: lookup("p", "p_id", "at") },
        staff("staff_id"),
        { otherSubjects: [person("about_id")] },
      ),
    );
    expect(own.classColumn).toBe("retention_class");
    expect(own.classes).toEqual([]);
    expect(own.personColumn).toBe("about_id");
  });

  it("plans every registry entry without throwing, and reads most tables", () => {
    const plans = RETENTION_REGISTRY.map(reportPlan);
    expect(plans.filter((p) => p.kind === "read").length).toBeGreaterThan(plans.length / 2);
  });
});

describe("groupStatus", () => {
  const care = read(personRecord("care_note", "care_record"));
  const ownClass = read(
    entry(
      "t",
      rowClass("retention_class", "complaint", "cctv"),
      { closedAt: col("c") },
      NO_SUBJECT,
    ),
  );
  const staffFile = read(
    entry(
      "t",
      classes("staff_file"),
      { employmentEndedAt: { from: "staff_leaving", column: "s", via: "staff_profile" } },
      staff("s"),
    ),
  );
  const rota = read(
    entry(
      "t",
      classes("rota_and_timesheet"),
      { createdAt: col("c"), periodEndsAt: col("p") },
      NO_SUBJECT,
    ),
  );
  const register = read(
    entry("t", classes("controlled_drugs_register"), { entryDates: col("e") }, NO_SUBJECT),
  );

  const cases: readonly [string, Extract<ReportPlan, { kind: "read" }>, ReportGroup, string][] = [
    ["held wins over due", care, group({ held: true, careEnded: d("2020-01-01") }), "held"],
    ["care ended over the period ago is due", care, group({ careEnded: d("2020-01-01") }), "due"],
    ["care ended recently is kept", care, group({ careEnded: d("2025-01-01") }), "retain"],
    ["still receiving care has no trigger", care, group({ receivingCare: true }), "no_trigger_yet"],
    ["no discharge yet has no trigger", care, group(), "no_trigger_yet"],
    [
      "the row's class decides",
      ownClass,
      group({ recordClass: "complaint", closedAt: d("2019-01-01") }),
      "due",
    ],
    [
      "a class by the organisation's policy",
      ownClass,
      group({ recordClass: "cctv" }),
      "tenant_policy",
    ],
    ["no class on the row", ownClass, group(), "tenant_policy"],
    ["an unknown class", ownClass, group({ recordClass: "nothing" }), "tenant_policy"],
    [
      "a staff file to the birthday",
      staffFile,
      group({ employmentEndedAt: d("2020-01-01"), dateOfBirth: d("1950-01-01") }),
      "due",
    ],
    [
      "a staff file with no date of birth is kept for a person to decide",
      staffFile,
      group({ employmentEndedAt: d("2020-01-01") }),
      "no_trigger_yet",
    ],
    [
      "a pay period class counts from the period end",
      rota,
      group({ createdAt: d("2020-01-01"), periodEndsAt: d("2024-12-31") }),
      "retain",
    ],
    [
      "a pay period class with no period end",
      rota,
      group({ createdAt: d("2020-01-01") }),
      "no_trigger_yet",
    ],
    ["the last entry on a register page", register, group({ entryDate: d("2027-01-01") }), "due"],
  ];
  it.each(cases)("%s", (_name, plan, g, expected) => {
    expect(groupStatus(plan, g, rules, NOW)).toBe(expected);
  });
});

describe("tallies", () => {
  it("adds counts per table and class, totals them and groups them by class", () => {
    const lines = new Map<string, ReportLine>();
    tally(lines, "care_note", "care_record", null, "due", 3);
    tally(lines, "care_note", "care_record", null, "held", 1);
    tally(lines, "observation", "care_record", null, "due", 2);
    tally(lines, "role", null, "kept_while_current", "never_offered", 5);
    expect(lines.size).toBe(3);
    expect(reportTotals(lines.values())).toEqual({
      ...emptyCounts(),
      due: 5,
      held: 1,
      never_offered: 5,
    });
    expect(countsByClass(lines.values())).toEqual({
      care_record: { ...emptyCounts(), due: 5, held: 1 },
    });
  });
});
